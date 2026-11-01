import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  fromTupleQuery,
  migrate,
} from '@toklyn/store/mysql';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const pool = mysql.createPool(env('MYSQL_URL'));
  // Your app queries through Drizzle; toklyn shares the same pool.
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
