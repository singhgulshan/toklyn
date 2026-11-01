import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor, MySqlRow } from '@toklyn/store/mysql';
import { CompiledQuery, Kysely, MysqlDialect } from 'kysely';
import { createPool } from 'mysql2';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';
import type { Database } from './database.js';

export async function connect(): Promise<Stores> {
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({ pool: createPool(requireEnv('MYSQL_URL')) }),
  });

  // Kysely passes mysql2 errors through unchanged, so the store's deadlock retries work.
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
  // Rotation runs inside a Kysely transaction, on one connection.
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
