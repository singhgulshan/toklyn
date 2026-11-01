import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromResultQuery,
  migrate,
} from '@toklyn/store/postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const pool = new pg.Pool({ connectionString: env('POSTGRES_URL') });
  // Your app queries through Drizzle; toklyn shares the same pool.
  const db = drizzle({ client: pool });
  const client = fromResultQuery(db.$client);
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
