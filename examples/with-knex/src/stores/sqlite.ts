import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  migrate,
} from '@toklyn/store/sqlite';
import type {
  SqliteClient,
  SqliteExecutor,
  SqliteRow,
} from '@toklyn/store/sqlite';
import knex from 'knex';
import type { Knex } from 'knex';
import { sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: sqlitePath() },
    useNullAsDefault: true,
  });

  // With better-sqlite3, knex.raw returns the rows for reads and `{ changes }` for writes.
  const executor = (runner: Knex): SqliteExecutor => ({
    all: (sql, params) => runner.raw<SqliteRow[]>(sql, [...params]),
    run: async (sql, params) =>
      (await runner.raw<{ changes: number }>(sql, [...params])).changes,
  });
  // Rotation runs inside a knex transaction, on its single connection.
  const client: SqliteClient = {
    ...executor(db),
    transaction: (fn) => db.transaction((trx) => fn(executor(trx))),
  };
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: () => db.destroy(),
  };
}
