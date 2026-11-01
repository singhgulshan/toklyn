import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor } from '@toklyn/store/mysql';
import knex from 'knex';
import type { Knex } from 'knex';
import { requireEnv, toMySqlResult } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const db = knex({ client: 'mysql2', connection: requireEnv('MYSQL_URL') });

  // knex passes mysql2 errors through unchanged, so the store's deadlock retries work.
  const executor = (runner: Knex): MySqlExecutor => ({
    async query(sql, params) {
      const [result] = await runner.raw<[unknown]>(sql, [...params]);
      return toMySqlResult(result);
    },
  });
  // Rotation runs inside a knex transaction, on one connection.
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
