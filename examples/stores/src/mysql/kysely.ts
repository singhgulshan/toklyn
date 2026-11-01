import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor, MySqlRow } from '@toklyn/store/mysql';
import { CompiledQuery, Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

// Your app's table types; toklyn's tables need none.
interface Database {
  users: { id: string; role: string };
}

export async function connect(): Promise<StoreExample> {
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({ pool: createPool(env('MYSQL_URL')) }),
  });

  // Kysely passes mysql2 errors through unchanged, so deadlock retries work as is.
  const executor = (runner: Kysely<Database>): MySqlExecutor => ({
    async query(sql, params) {
      const result = await runner.executeQuery(
        CompiledQuery.raw(sql, [...params]),
      );
      return {
        rows: result.rows as MySqlRow[],
        affectedRows: Number(result.numAffectedRows ?? 0n),
      };
    },
  });
  const client: MySqlClient = {
    ...executor(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(executor(trx))),
  };
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => db.destroy(),
  };
}
