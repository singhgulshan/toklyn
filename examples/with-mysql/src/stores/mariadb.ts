import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  fromDirectQuery,
  migrate,
} from '@toklyn/store/mysql';
import mariadb from 'mariadb';
import { mysqlOptions, requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const pool = mariadb.createPool(mysqlOptions(requireEnv('MARIADB_URL')));
  const client = fromDirectQuery(pool);
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
