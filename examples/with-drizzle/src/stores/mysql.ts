import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  fromTupleQuery,
  migrate,
} from '@toklyn/store/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const pool = mysql.createPool(requireEnv('MYSQL_URL'));
  // Your app queries through Drizzle; toklyn shares the pool Drizzle runs on.
  const db = drizzle({ client: pool });
  const client = fromTupleQuery(pool);
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: async () => {
      await db.$client.end();
    },
  };
}
