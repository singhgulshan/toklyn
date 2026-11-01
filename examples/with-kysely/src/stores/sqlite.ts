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
import Database from 'better-sqlite3';
import { CompiledQuery, Kysely, SqliteDialect } from 'kysely';
import { sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';
import type { Database as Tables } from './database.js';

export async function connect(): Promise<Stores> {
  const db = new Kysely<Tables>({
    dialect: new SqliteDialect({ database: new Database(sqlitePath()) }),
  });

  const executor = (runner: Kysely<Tables>): SqliteExecutor => ({
    async all(sql, params) {
      const result = await runner.executeQuery(
        CompiledQuery.raw(sql, [...params]),
      );
      return result.rows as SqliteRow[];
    },
    async run(sql, params) {
      const result = await runner.executeQuery(
        CompiledQuery.raw(sql, [...params]),
      );
      return Number(result.numAffectedRows ?? 0n);
    },
  });
  // Rotation runs inside a Kysely transaction, on its single connection.
  const client: SqliteClient = {
    ...executor(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(executor(trx))),
  };
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: () => db.destroy(),
  };
}
