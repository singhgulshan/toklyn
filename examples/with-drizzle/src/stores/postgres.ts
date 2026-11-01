import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromResultQuery,
  migrate,
} from '@toklyn/store/postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const pool = new pg.Pool({ connectionString: requireEnv('POSTGRES_URL') });
  // Your app queries through Drizzle; toklyn shares the pool Drizzle runs on.
  const db = drizzle({ client: pool });
  const client = fromResultQuery(db.$client);
  // Creates toklyn's tables if missing. In production, run it from a deploy step.
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
