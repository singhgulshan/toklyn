import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  fromTupleQuery,
  migrate,
} from '@toklyn/store/mysql';
import mysql from 'mysql2/promise';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const pool = mysql.createPool(env('MYSQL_URL'));
  const client = fromTupleQuery(pool);
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
