import { ToklynError } from 'toklyn';
import { describe, expect, it, vi } from 'vitest';
import { isBusy, retryWhenBusy } from '#src/sqlite/busy.js';
import {
  SqliteSessionStore,
  createSchemaSql,
  fromExecuteDatabase,
  fromSyncDatabase,
} from '#src/sqlite/index.js';
import type {
  ExecuteDatabase,
  ExecuteTransaction,
  SyncDatabase,
} from '#src/sqlite/index.js';

function fakeSync(
  respond: (sql: string) => { rows?: unknown; changes?: unknown } = () => ({}),
) {
  const log: string[] = [];
  const prepared: string[] = [];
  const db: SyncDatabase = {
    prepare(sql) {
      prepared.push(sql);
      return {
        all: (...params) => {
          log.push(`${sql} ${JSON.stringify(params)}`);
          return (respond(sql).rows ?? []) as unknown[];
        },
        run: (...params) => {
          log.push(`${sql} ${JSON.stringify(params)}`);
          return { changes: (respond(sql).changes ?? 0) as number };
        },
      };
    },
  };
  return { db, log, prepared };
}

const busy = () =>
  Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

describe('fromSyncDatabase', () => {
  it('runs a query issued during a transaction after the transaction ends', async () => {
    const { db, log } = fakeSync();
    const client = fromSyncDatabase(db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const tx = client.transaction(async (t) => {
      await t.run('UPDATE a', []);
      await gate;
      await t.run('UPDATE b', []);
    });
    const outside = client.run('UPDATE outside', []);
    await Promise.resolve();
    release();
    await Promise.all([tx, outside]);

    expect(log).toEqual([
      'BEGIN IMMEDIATE []',
      'UPDATE a []',
      'UPDATE b []',
      'COMMIT []',
      'UPDATE outside []',
    ]);
  });

  it('rolls back and rethrows when the work fails, even if ROLLBACK fails too', async () => {
    const { db, log } = fakeSync((sql) => {
      if (sql === 'ROLLBACK') throw new Error('no transaction is active');
      return {};
    });
    const client = fromSyncDatabase(db);
    const failure = new Error('boom');

    await expect(
      client.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(log).toEqual(['BEGIN IMMEDIATE []', 'ROLLBACK []']);
    // The queue keeps working after a failure.
    await expect(client.run('UPDATE x', [])).resolves.toBe(0);
  });

  it('prepares each statement once and passes params positionally', async () => {
    const { db, log, prepared } = fakeSync(() => ({ changes: 2n }));
    const client = fromSyncDatabase(db);

    expect(await client.run('UPDATE x', ['a', null])).toBe(2);
    await client.run('UPDATE x', ['b', null]);

    expect(prepared).toEqual(['UPDATE x']);
    expect(log).toEqual(['UPDATE x ["a",null]', 'UPDATE x ["b",null]']);
  });

  it('rejects malformed replies with storage_error', async () => {
    const client = fromSyncDatabase(
      fakeSync((sql) => (sql === 'ROWS' ? { rows: [1] } : { changes: 'many' }))
        .db,
    );

    await expect(client.all('ROWS', [])).rejects.toMatchObject({
      code: 'storage_error',
    });
    await expect(client.run('RUN', [])).rejects.toBeInstanceOf(ToklynError);
  });
});

describe('fromExecuteDatabase', () => {
  function fakeExecute(failCommit = false) {
    const calls: string[] = [];
    const tx: ExecuteTransaction = {
      execute: async ({ sql, args }) => {
        calls.push(`tx ${sql} ${JSON.stringify(args)}`);
        return { rows: [{ v: 'x' }], rowsAffected: 1 };
      },
      commit: async () => {
        calls.push('commit');
        if (failCommit) throw busy();
      },
      rollback: async () => {
        calls.push('rollback');
        throw new Error('already settled');
      },
      close: () => calls.push('close'),
    };
    const db: ExecuteDatabase = {
      execute: async ({ sql }) => {
        calls.push(sql);
        return { rows: [], rowsAffected: 3n };
      },
      transaction: async (mode) => {
        calls.push(`begin ${mode}`);
        return tx;
      },
    };
    return { db, calls };
  }

  it('maps rows and changes', async () => {
    const { db } = fakeExecute();
    const client = fromExecuteDatabase(db);

    expect(await client.run('DELETE', [])).toBe(3);
    expect(await client.transaction((tx) => tx.all('SELECT', ['a']))).toEqual([
      { v: 'x' },
    ]);
  });

  it('uses a write transaction and closes it after commit', async () => {
    const { db, calls } = fakeExecute();

    await fromExecuteDatabase(db).transaction((tx) => tx.run('UPDATE', ['a']));

    expect(calls).toEqual([
      'begin write',
      'tx UPDATE ["a"]',
      'commit',
      'close',
    ]);
  });

  it('rolls back and closes when commit fails, keeping the original error', async () => {
    const { db, calls } = fakeExecute(true);

    await expect(
      fromExecuteDatabase(db).transaction(async () => 1),
    ).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(calls).toEqual(['begin write', 'commit', 'rollback', 'close']);
  });
});

describe('busy handling', () => {
  it.each([
    [{ code: 'SQLITE_BUSY' }, true],
    [{ code: 'SQLITE_BUSY_SNAPSHOT' }, true],
    [{ code: 'ERR_SQLITE_ERROR', errcode: 5 }, true],
    [{ code: 'ERR_SQLITE_ERROR', errcode: 517 }, true],
    [{ rawCode: 5 }, true],
    [{ errno: 5 }, true],
    [{ errno: -251 }, false],
    [{ code: 'SQLITE_CONSTRAINT_PRIMARYKEY', errcode: 1555 }, false],
    [{ code: 'ERR_SQLITE_ERROR', errcode: 6 }, false],
    [null, false],
    ['SQLITE_BUSY', false],
  ])('isBusy(%j) is %s', (error, expected) => {
    expect(isBusy(error)).toBe(expected);
  });

  it('retries busy errors until the work succeeds', async () => {
    const work = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue('done');

    await expect(retryWhenBusy(work)).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('gives up after 10 attempts', async () => {
    const work = vi.fn<() => Promise<never>>().mockRejectedValue(busy());

    await expect(retryWhenBusy(work)).rejects.toMatchObject({
      code: 'SQLITE_BUSY',
    });
    expect(work).toHaveBeenCalledTimes(10);
  });

  it('does not retry other errors', async () => {
    const work = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error('UNIQUE constraint failed'));

    await expect(retryWhenBusy(work)).rejects.toThrow('UNIQUE');
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe('schema options', () => {
  it.each(['Toklyn_', '1abc', 'a-b', 'a"b', 'x'.repeat(25)])(
    'rejects tablePrefix %j',
    (tablePrefix) => {
      expect(() => createSchemaSql({ tablePrefix })).toThrow(
        expect.objectContaining({ code: 'invalid_config' }),
      );
      expect(
        () =>
          new SqliteSessionStore({
            client: fromSyncDatabase(fakeSync().db),
            tablePrefix,
          }),
      ).toThrow(ToklynError);
    },
  );

  it('prefixes tables and indexes and accepts an empty prefix', () => {
    expect(createSchemaSql({ tablePrefix: 'app_' })).toContain(
      'CREATE INDEX IF NOT EXISTS "app_sessions_subject_idx" ON "app_sessions" (subject)',
    );
    expect(createSchemaSql({ tablePrefix: '' })).toContain(
      'CREATE TABLE IF NOT EXISTS "sessions"',
    );
  });
});
