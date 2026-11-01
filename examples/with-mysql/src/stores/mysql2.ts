import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  fromTupleQuery,
  migrate,
} from '@toklyn/store/mysql';
import mysql from 'mysql2/promise';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const pool = mysql.createPool(requireEnv('MYSQL_URL'));
  const client = fromTupleQuery(pool);
  // Creates toklyn's tables if missing. In production, run it from a deploy step.
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
