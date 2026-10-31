import type { NewSession, Session } from 'toklyn';
import { ToklynError } from 'toklyn';
import { describe, expect, it } from 'vitest';
import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  createSchemaSql,
  fromDirectQuery,
  fromTupleQuery,
} from '#src/mysql/index.js';
import type {
  MySqlClient,
  MySqlResult,
  QueryConnection,
  QueryPool,
} from '#src/mysql/index.js';

const T0 = 1_700_000_000_123;
const HOUR = 3_600_000;
const NOW = T0 + 1000;

type Call = [sql: string, params: readonly (string | null)[]];

/** Replies with `results` in order and records every statement. */
function scripted(results: Partial<MySqlResult>[]) {
  const calls: Call[] = [];
  let transactions = 0;
  const next = async (sql: string, params: readonly (string | null)[]) => {
    calls.push([sql, params]);
    const result = results.shift() ?? {};
    return { rows: result.rows ?? [], affectedRows: result.affectedRows ?? 0 };
  };
  const client: MySqlClient = {
    query: next,
    async transaction(fn) {
      transactions += 1;
      return fn({ query: next });
    },
  };
  return { client, calls, transactions: () => transactions };
}

function lockedRow(
  session: Partial<Record<string, string | null>> = {},
  token: { expiresAt?: number; consumedAt?: number | null } = {},
) {
  return {
    id: 'session-1',
    subject: 'user-1',
    claims: '{"role":"admin"}',
    metadata: '{}',
    created_at: String(T0),
    last_refreshed_at: String(T0),
    expires_at: String(T0 + 2 * HOUR),
    revoked_at: null,
    token_expires_at: String(token.expiresAt ?? T0 + HOUR),
    token_consumed_at:
      token.consumedAt === undefined || token.consumedAt === null
        ? null
        : String(token.consumedAt),
    ...session,
  };
}

function rotate(store: MySqlSessionStore, overrides = {}) {
  return store.rotate({
    presentedHash: 'hash-1',
    newHash: 'hash-2',
    now: NOW,
    refreshTtlMs: HOUR,
    reuseGraceMs: 0,
    ...overrides,
  });
}

function newSession(overrides: Partial<Session> = {}): NewSession {
  const session: Session = {
    id: 'session-1',
    subject: 'user-1',
    claims: { role: 'admin' },
    metadata: {},
    createdAt: T0,
    lastRefreshedAt: T0,
    expiresAt: T0 + 2 * HOUR,
    revokedAt: null,
    ...overrides,
  };
  return {
    session,
    refreshToken: {
      hash: 'hash-1',
      sessionId: session.id,
      issuedAt: T0,
      expiresAt: T0 + HOUR,
      consumedAt: null,
    },
  };
}

describe('MySqlSessionStore.rotate decisions', () => {
  it('reports an unknown token after one locking read', async () => {
    const db = scripted([{ rows: [] }]);

    const result = await rotate(new MySqlSessionStore({ client: db.client }));

    expect(result).toEqual({ status: 'unknown_token' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.[0]).toMatch(/FOR UPDATE$/);
  });

  it.each([
    ['session_revoked', lockedRow({ revoked_at: String(T0) })],
    ['session_expired', lockedRow({ expires_at: String(NOW) })],
  ])('refuses with %s and writes nothing', async (status, row) => {
    const db = scripted([{ rows: [row] }]);

    const result = await rotate(new MySqlSessionStore({ client: db.client }));

    expect(result.status).toBe(status);
    expect(db.calls).toHaveLength(1);
  });

  it('revokes the session when a consumed token comes back outside the grace window', async () => {
    const db = scripted([{ rows: [lockedRow({}, { consumedAt: T0 })] }]);

    const result = await rotate(new MySqlSessionStore({ client: db.client }), {
      reuseGraceMs: 500,
    });

    expect(result.status).toBe('reuse_detected');
    expect(result.status === 'reuse_detected' && result.session.revokedAt).toBe(
      NOW,
    );
    expect(db.calls[1]).toEqual([
      expect.stringMatching(/^UPDATE `toklyn_sessions` SET revoked_at/),
      [String(NOW), 'session-1'],
    ]);
  });

  it('reports an expired token without writing', async () => {
    const db = scripted([{ rows: [lockedRow({}, { expiresAt: NOW })] }]);

    const result = await rotate(new MySqlSessionStore({ client: db.client }));

    expect(result).toEqual({ status: 'token_expired' });
    expect(db.calls).toHaveLength(1);
  });

  it('rotates inside the grace window, caps the successor at the session expiry and stores new claims', async () => {
    const db = scripted([
      {
        rows: [lockedRow({ expires_at: String(NOW + 10) }, { consumedAt: T0 })],
      },
    ]);

    const result = await rotate(new MySqlSessionStore({ client: db.client }), {
      reuseGraceMs: 5000,
      claims: { role: 'user', tags: [] },
    });

    expect(result).toMatchObject({
      status: 'rotated',
      session: { lastRefreshedAt: NOW, claims: { role: 'user', tags: [] } },
      refreshToken: {
        hash: 'hash-2',
        sessionId: 'session-1',
        issuedAt: NOW,
        expiresAt: NOW + 10,
        consumedAt: null,
      },
    });
    expect(db.calls.slice(1).map(([, params]) => params)).toEqual([
      [String(NOW), String(NOW), '{"role":"user","tags":[]}', 'hash-1'],
      ['hash-2', 'session-1', String(NOW), String(NOW + 10), null],
    ]);
  });

  it('keeps the stored claims when none are supplied', async () => {
    const db = scripted([{ rows: [lockedRow()] }]);

    const result = await rotate(new MySqlSessionStore({ client: db.client }));

    expect(result.status === 'rotated' && result.session.claims).toEqual({
      role: 'admin',
    });
    expect(db.calls[1]?.[1][2]).toBeNull();
  });

  it('reports an unexpected row as a storage error', async () => {
    const db = scripted([{ rows: [{ ...lockedRow(), created_at: 1 }] }]);

    const error = await rotate(
      new MySqlSessionStore({ client: db.client }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToklynError);
    expect((error as ToklynError).code).toBe('storage_error');
  });
});

describe('MySqlSessionStore transactions', () => {
  function failing(errors: unknown[]) {
    let attempts = 0;
    const client: MySqlClient = {
      query: async () => ({ rows: [], affectedRows: 0 }),
      async transaction(fn) {
        attempts += 1;
        const error = errors.shift();
        if (error) throw error;
        return fn({ query: async () => ({ rows: [], affectedRows: 0 }) });
      },
    };
    return { client, attempts: () => attempts };
  }

  it('retries after a deadlock or lock wait timeout', async () => {
    const db = failing([{ errno: 1213 }, { errno: 1205 }]);

    const result = await rotate(new MySqlSessionStore({ client: db.client }));

    expect(result.status).toBe('unknown_token');
    expect(db.attempts()).toBe(3);
  });

  it('gives up after three attempts', async () => {
    const deadlock = { errno: 1213 };
    const db = failing([deadlock, deadlock, deadlock, deadlock]);

    await expect(
      rotate(new MySqlSessionStore({ client: db.client })),
    ).rejects.toBe(deadlock);
    expect(db.attempts()).toBe(3);
  });

  it('does not retry other errors', async () => {
    const duplicate = { errno: 1062 };
    const db = failing([duplicate]);

    await expect(
      new MySqlSessionStore({ client: db.client }).create(newSession()),
    ).rejects.toBe(duplicate);
    expect(db.attempts()).toBe(1);
  });

  it('creates the session and its token in one transaction', async () => {
    const db = scripted([]);

    await new MySqlSessionStore({ client: db.client }).create(newSession());

    expect(db.transactions()).toBe(1);
    expect(db.calls.map(([sql]) => sql.split('\n')[0])).toEqual([
      'INSERT INTO `toklyn_sessions`',
      'INSERT INTO `toklyn_refresh_tokens`',
    ]);
  });

  it('revokes exactly the sessions it locked', async () => {
    const db = scripted([
      {
        rows: [lockedRow({ id: 's-1' }), lockedRow({ id: 's-2' })],
      },
    ]);

    const revoked = await new MySqlSessionStore({
      client: db.client,
    }).revokeAllForSubject('user-1', NOW);

    expect(revoked.map((s) => [s.id, s.revokedAt])).toEqual([
      ['s-1', NOW],
      ['s-2', NOW],
    ]);
    expect(db.calls[1]).toEqual([
      expect.stringMatching(/WHERE id IN \(\?, \?\)$/),
      [String(NOW), 's-1', 's-2'],
    ]);
  });

  it('returns the affected row count from purgeExpired', async () => {
    const db = scripted([{ affectedRows: 3 }]);

    expect(
      await new MySqlSessionStore({ client: db.client }).purgeExpired(NOW),
    ).toBe(3);
  });
});

describe('key length', () => {
  const tooLong = 'é'.repeat(128);

  it.each([
    ['session id', newSession({ id: tooLong })],
    ['subject', newSession({ subject: tooLong })],
  ])(
    'rejects a %s over 255 bytes before touching the database',
    async (_, input) => {
      const db = scripted([]);

      await expect(
        new MySqlSessionStore({ client: db.client }).create(input),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      expect(db.calls).toEqual([]);
    },
  );

  it('accepts exactly 255 bytes', async () => {
    const db = scripted([]);

    await new MySqlSessionStore({ client: db.client }).create(
      newSession({ subject: 'x'.repeat(255) }),
    );

    expect(db.calls).toHaveLength(2);
  });

  it('rejects an over-long jti on revoke', async () => {
    const db = scripted([]);
    const store = new MySqlAccessTokenRevocationStore({
      client: db.client,
      clock: { now: () => T0 },
    });

    await expect(store.revoke(tooLong, T0 + HOUR)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(db.calls).toEqual([]);
  });
});

describe('MySqlAccessTokenRevocationStore', () => {
  it('keeps the later expiry and skips expired entries', async () => {
    const db = scripted([]);
    const store = new MySqlAccessTokenRevocationStore({
      client: db.client,
      clock: { now: () => T0 },
    });

    await store.revoke('jti', T0);
    await store.revoke('jti', T0 + HOUR);

    expect(db.calls).toEqual([
      [
        expect.stringContaining('GREATEST(expires_at, CAST(? AS SIGNED))'),
        ['jti', String(T0 + HOUR), String(T0 + HOUR)],
      ],
    ]);
  });
});

describe('schema', () => {
  it('uses binary keys, BIGINT times and InnoDB', () => {
    const sql = createSchemaSql();

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `toklyn_sessions`');
    expect(sql).toContain('subject VARBINARY(255) NOT NULL');
    expect(sql).toContain('expires_at BIGINT NOT NULL');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql.match(/ENGINE=InnoDB/g)).toHaveLength(3);
  });

  it('qualifies tables with the database', () => {
    expect(createSchemaSql({ database: 'auth', tablePrefix: '' })).toContain(
      'CREATE TABLE IF NOT EXISTS `auth`.`sessions`',
    );
  });

  it.each([
    ['database', { database: 'Auth' }],
    ['database', { database: 'a`; DROP TABLE x; --' }],
    ['database', { database: '' }],
    ['database', { database: 'x'.repeat(65) }],
    ['tablePrefix', { tablePrefix: '1x_' }],
    ['tablePrefix', { tablePrefix: 'a-b' }],
    ['tablePrefix', { tablePrefix: 'x'.repeat(25) }],
  ])('rejects an invalid %s', (_, options) => {
    const client = scripted([]).client;
    for (const build of [
      () => createSchemaSql(options),
      () => new MySqlSessionStore({ client, ...options }),
      () => new MySqlAccessTokenRevocationStore({ client, ...options }),
    ]) {
      expect(build).toThrow(
        expect.objectContaining({ code: 'invalid_config' }) as Error,
      );
    }
  });
});

describe('client adapters', () => {
  function fakePool(reply: (sql: string) => unknown) {
    const log: string[] = [];
    const connection: QueryConnection & {
      released: number;
      destroyed: number;
    } = {
      released: 0,
      destroyed: 0,
      query: async (sql) => {
        log.push(`conn.query ${sql}`);
        return reply(sql);
      },
      execute: async (sql) => {
        log.push(`conn.execute ${sql}`);
        return reply(sql);
      },
      release() {
        connection.released += 1;
      },
      destroy() {
        connection.destroyed += 1;
      },
    };
    const pool: QueryPool = {
      query: async (sql) => {
        log.push(`pool.query ${sql}`);
        return reply(sql);
      },
      execute: async (sql) => {
        log.push(`pool.execute ${sql}`);
        return reply(sql);
      },
      getConnection: async () => connection,
    };
    return { pool, connection, log };
  }

  it('read rows and affected rows from both reply shapes', async () => {
    const rows = [{ ok: '1' }];
    const tuple = fromTupleQuery(
      fakePool((sql) =>
        sql.startsWith('SELECT')
          ? [rows, []]
          : [{ affectedRows: 2 }, undefined],
      ).pool,
    );
    const direct = fromDirectQuery(
      fakePool((sql) =>
        sql.startsWith('SELECT') ? rows : { affectedRows: 2n },
      ).pool,
    );

    for (const client of [tuple, direct]) {
      expect(await client.query('SELECT 1', [])).toEqual({
        rows,
        affectedRows: 0,
      });
      expect(await client.query('DELETE x', [])).toEqual({
        rows: [],
        affectedRows: 2,
      });
    }
  });

  it('use execute only when prepare is on, never for transaction control', async () => {
    const { pool, log } = fakePool(() => []);
    const client = fromDirectQuery(pool, { prepare: true });

    await client.query('SELECT 1', []);
    await client.transaction((tx) => tx.query('SELECT 2', []));

    expect(log).toEqual([
      'pool.execute SELECT 1',
      'conn.query START TRANSACTION',
      'conn.execute SELECT 2',
      'conn.query COMMIT',
    ]);
  });

  it('roll back and release the connection when the work fails', async () => {
    const { pool, connection, log } = fakePool(() => []);
    const boom = new Error('boom');

    await expect(
      fromDirectQuery(pool).transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(log).toEqual([
      'conn.query START TRANSACTION',
      'conn.query ROLLBACK',
    ]);
    expect([connection.released, connection.destroyed]).toEqual([1, 0]);
  });

  it('destroy the connection when the rollback fails', async () => {
    const { pool, connection } = fakePool((sql) => {
      if (sql === 'ROLLBACK') throw new Error('gone');
      return [];
    });
    const boom = new Error('boom');

    await expect(
      fromDirectQuery(pool).transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect([connection.released, connection.destroyed]).toEqual([0, 1]);
  });

  it('reject a reply of the wrong shape', async () => {
    const tuple = fromTupleQuery(fakePool(() => 'nope').pool);
    const direct = fromDirectQuery(fakePool(() => ({})).pool);

    for (const client of [tuple, direct]) {
      await expect(client.query('SELECT 1', [])).rejects.toMatchObject({
        code: 'storage_error',
      });
    }
  });
});
