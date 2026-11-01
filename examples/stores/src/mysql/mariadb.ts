import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  fromDirectQuery,
  migrate,
} from '@toklyn/store/mysql';
import mariadb from 'mariadb';
import { env, mysqlOptions } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const pool = mariadb.createPool(mysqlOptions(env('MARIADB_URL')));
  const client = fromDirectQuery(pool);
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
