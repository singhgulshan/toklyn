import { PGlite } from '@electric-sql/pglite';
import type { NewSession, Session } from 'toklyn';
import { ToklynError } from 'toklyn';
import { revocationStoreContract, sessionStoreContract } from 'toklyn/testing';
import { describe, expect, it } from 'vitest';
import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  createSchemaSql,
  fromResultQuery,
  fromUnsafeQuery,
  fromVariadicQuery,
  migrate,
} from '#src/index.js';
import type { TestDatabase } from './postgres.js';
import {
  POSTGRES_URL,
  lazyRevocationStore,
  usePGlite,
  useServer,
} from './postgres.js';

const T0 = 1_700_000_000_123;
const HOUR = 3_600_000;

function contracts(name: string, db: TestDatabase) {
  sessionStoreContract(
    `PostgresSessionStore (${name})`,
    async () =>
      new PostgresSessionStore({
        client: db.client,
        schema: await db.freshSchema(),
      }),
  );
  revocationStoreContract(
    `PostgresAccessTokenRevocationStore (${name})`,
    (clock) =>
      lazyRevocationStore(
        async () =>
          new PostgresAccessTokenRevocationStore({
            client: db.client,
            schema: await db.freshSchema(),
            clock,
          }),
      ),
  );
}

const pglite = usePGlite();
contracts('PGlite', pglite);

if (POSTGRES_URL) {
  const server = useServer();
  contracts('node-postgres', server.pool);
  contracts('postgres.js', server.unsafe);
  contracts('node-postgres, prepared', server.poolPrepared);
  contracts('postgres.js, prepared', server.unsafePrepared);

  describe('concurrent rotation on a real server', () => {
    async function race(reuseGraceMs: number) {
      const store = new PostgresSessionStore({
        client: server.pool.client,
        schema: await server.pool.freshSchema(),
      });
      await store.create(newSession());
      return Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.rotate({
            presentedHash: 'hash-1',
            newHash: `hash-next-${i}`,
            now: T0 + 1000,
            refreshTtlMs: HOUR,
            reuseGraceMs,
          }),
        ),
      );
    }

    it('lets exactly one of many rotations win without a grace window', async () => {
      const statuses = (await race(0)).map((r) => r.status);

      expect(statuses.filter((s) => s === 'rotated')).toHaveLength(1);
      expect(
        statuses.every((s) =>
          ['rotated', 'reuse_detected', 'session_revoked'].includes(s),
        ),
      ).toBe(true);
    });

    it('lets all of them win inside the grace window', async () => {
      const statuses = (await race(10_000)).map((r) => r.status);

      expect(statuses.every((s) => s === 'rotated')).toBe(true);
    });
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

describe('PostgresSessionStore', () => {
  async function setup(tablePrefix?: string) {
    const schema = await pglite.freshSchema();
    if (tablePrefix !== undefined) {
      await migrate(pglite.client, { schema, tablePrefix });
    }
    const store = new PostgresSessionStore({
      client: pglite.client,
      schema,
      ...(tablePrefix === undefined ? {} : { tablePrefix }),
    });
    return { store, schema };
  }

  it('round-trips claims with empty arrays and nested objects', async () => {
    const { store } = await setup();
    const claims = {
      roles: [],
      scopes: ['read'],
      org: { id: 'o-1', tags: [] },
    };
    await store.create(newSession({ claims }));

    expect((await store.find('session-1'))?.claims).toEqual(claims);

    const result = await store.rotate({
      presentedHash: 'hash-1',
      newHash: 'hash-2',
      now: T0 + 1000,
      refreshTtlMs: HOUR,
      reuseGraceMs: 0,
      claims: { roles: [] },
    });
    expect(result.status === 'rotated' && result.session.claims).toEqual({
      roles: [],
    });
  });

  it('keeps millisecond timestamps exact', async () => {
    const { store } = await setup();
    const session = newSession({
      createdAt: T0 + 1,
      lastRefreshedAt: T0 + 999,
      expiresAt: 8_640_000_000_000 - 7,
      revokedAt: T0 + 5,
    });
    await store.create(session);

    expect(await store.find('session-1')).toEqual(session.session);
  });

  it('works with a custom table prefix', async () => {
    const { store, schema } = await setup('app_auth_');
    await store.create(newSession());

    const tables = await pglite.client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
      [schema],
    );
    expect(tables.map((t) => t['table_name'])).toEqual([
      'app_auth_access_token_revocations',
      'app_auth_refresh_tokens',
      'app_auth_sessions',
      'toklyn_access_token_revocations',
      'toklyn_refresh_tokens',
      'toklyn_sessions',
    ]);
    expect((await store.find('session-1'))?.subject).toBe('user-1');
  });

  it('rejects a token hash that already exists', async () => {
    const { store } = await setup();
    await store.create(newSession());

    await expect(
      store.create(newSession({ id: 'session-2' })),
    ).rejects.toThrow();
    expect(await store.find('session-2')).toBeNull();
  });

  it('reports an unexpected reply as a storage error', async () => {
    const store = new PostgresSessionStore({
      client: { query: async () => [{ id: 'session-1' }] },
    });

    const error = await store.find('session-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToklynError);
    expect((error as ToklynError).code).toBe('storage_error');
  });
});

describe('PostgresAccessTokenRevocationStore', () => {
  it('purges expired entries only', async () => {
    let now = T0;
    const store = new PostgresAccessTokenRevocationStore({
      client: pglite.client,
      schema: await pglite.freshSchema(),
      clock: { now: () => now },
    });
    await store.revoke('short', T0 + 1000);
    await store.revoke('long', T0 + HOUR);
    now = T0 + 2000;

    expect(await store.purgeExpired()).toBe(1);
    expect(await store.isRevoked('long')).toBe(true);
  });

  it('keeps the later expiry when revoked twice', async () => {
    let now = T0;
    const store = new PostgresAccessTokenRevocationStore({
      client: pglite.client,
      schema: await pglite.freshSchema(),
      clock: { now: () => now },
    });
    await store.revoke('jti', T0 + HOUR);
    await store.revoke('jti', T0 + 1000);
    now = T0 + 2000;

    expect(await store.isRevoked('jti')).toBe(true);
  });
});

describe('schema', () => {
  it('migrate can run more than once', async () => {
    const schema = await pglite.freshSchema();

    await expect(migrate(pglite.client, { schema })).resolves.toBeUndefined();
  });

  it('createSchemaSql matches what migrate creates', async () => {
    const db = new PGlite();
    await db.exec(createSchemaSql({ schema: 'auth', tablePrefix: 'x_' }));
    const store = new PostgresSessionStore({
      client: fromResultQuery(db),
      schema: 'auth',
      tablePrefix: 'x_',
    });

    await store.create(newSession());

    expect(await store.listForSubject('user-1', T0)).toHaveLength(1);
    await db.close();
  });

  it.each([
    ['schema', { schema: 'Auth' }],
    ['schema', { schema: 'a"; DROP TABLE x; --' }],
    ['schema', { schema: '' }],
    ['schema', { schema: 'x'.repeat(64) }],
    ['tablePrefix', { tablePrefix: '1x_' }],
    ['tablePrefix', { tablePrefix: 'a-b' }],
    ['tablePrefix', { tablePrefix: 'x'.repeat(25) }],
  ])('rejects an invalid %s', (_, options) => {
    for (const build of [
      () => createSchemaSql(options),
      () => new PostgresSessionStore({ client: pglite.client, ...options }),
      () =>
        new PostgresAccessTokenRevocationStore({
          client: pglite.client,
          ...options,
        }),
    ]) {
      expect(build).toThrow(
        expect.objectContaining({ code: 'invalid_config' }) as Error,
      );
    }
  });

  it('allows an empty prefix with a dedicated schema', () => {
    expect(createSchemaSql({ schema: 'auth', tablePrefix: '' })).toContain(
      'CREATE TABLE IF NOT EXISTS "auth"."sessions"',
    );
  });
});

describe('client adapters', () => {
  it('map their call shapes onto query(text, params)', async () => {
    const calls: unknown[][] = [];
    const rows = [{ ok: 1 }];
    const clients = [
      fromResultQuery({
        query: async (...args) => {
          calls.push(args);
          return { rows };
        },
      }),
      fromUnsafeQuery({
        unsafe: async (...args) => {
          calls.push(args);
          return rows;
        },
      }),
      fromVariadicQuery({
        $queryRawUnsafe: async (...args) => {
          calls.push(args);
          return rows;
        },
      }),
    ];

    for (const client of clients) {
      expect(await client.query('SELECT $1, $2', ['a', null])).toEqual(rows);
    }
    expect(calls).toEqual([
      ['SELECT $1, $2', ['a', null]],
      ['SELECT $1, $2', ['a', null]],
      ['SELECT $1, $2', 'a', null],
    ]);
  });

  it('use a stable statement name or flag when prepare is on', async () => {
    const calls: unknown[][] = [];
    const named = fromResultQuery(
      {
        query: async (...args: unknown[]) => {
          calls.push(args);
          return { rows: [] };
        },
      },
      { prepare: true },
    );
    const unsafe = fromUnsafeQuery(
      {
        unsafe: async (...args) => {
          calls.push(args);
          return [];
        },
      },
      { prepare: true },
    );

    await named.query('SELECT $1', ['a']);
    await named.query('SELECT $1', ['b']);
    await named.query('SELECT 2', []);
    await unsafe.query('SELECT $1', ['a']);

    const [first, second, other] = calls
      .slice(0, 3)
      .map(
        ([config]) =>
          config as { name: string; text: string; values: unknown[] },
      );
    expect(first).toMatchObject({ text: 'SELECT $1', values: ['a'] });
    expect(first?.name).toMatch(/^toklyn_[0-9a-f]{16}$/);
    expect(second?.name).toBe(first?.name);
    expect(other?.name).not.toBe(first?.name);
    expect(calls[3]).toEqual(['SELECT $1', ['a'], { prepare: true }]);
  });

  it('only allows prepare on clients with the named query form', () => {
    const typeOnly = (db: PGlite) =>
      // @ts-expect-error PGlite has no query({ name, text, values })
      fromResultQuery(db, { prepare: true });

    expect(typeOnly).toBeTypeOf('function');
  });

  it('reject a reply that is not a row list', async () => {
    const client = fromUnsafeQuery({ unsafe: async () => 'nope' });

    await expect(client.query('SELECT 1', [])).rejects.toMatchObject({
      code: 'storage_error',
    });
  });
});
