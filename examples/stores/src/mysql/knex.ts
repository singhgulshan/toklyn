import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor } from '@toklyn/store/mysql';
import knex from 'knex';
import type { Knex } from 'knex';
import { env, toMySqlResult } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const db = knex({ client: 'mysql2', connection: env('MYSQL_URL') });

  // knex passes mysql2 errors through unchanged, so deadlock retries work as is.
  const executor = (runner: Knex): MySqlExecutor => ({
    async query(sql, params) {
      const [result] = await runner.raw<[unknown]>(sql, [...params]);
      return toMySqlResult(result);
    },
  });
  const client: MySqlClient = {
    ...executor(db),
    transaction: (fn) => db.transaction((trx) => fn(executor(trx))),
  };
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => db.destroy(),
  };
}
