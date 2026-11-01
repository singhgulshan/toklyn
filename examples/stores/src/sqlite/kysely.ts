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
import type { StoreExample } from '../example.js';

// Your app's table types; toklyn's tables need none.
interface Tables {
  users: { id: string; role: string };
}

export async function connect(): Promise<StoreExample> {
  const db = new Kysely<Tables>({
    dialect: new SqliteDialect({
      database: new Database(process.env.SQLITE_PATH ?? 'toklyn-example.db'),
    }),
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
