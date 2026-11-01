import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromResultQuery,
  migrate,
} from '@toklyn/store/postgres';
import pg from 'pg';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const pool = new pg.Pool({ connectionString: requireEnv('POSTGRES_URL') });
  // Prepared statements make rotation faster; leave them off behind transaction-mode poolers.
  const client = fromResultQuery(pool, { prepare: true });
  // Creates toklyn's tables if missing. In production, run it from a deploy step.
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
