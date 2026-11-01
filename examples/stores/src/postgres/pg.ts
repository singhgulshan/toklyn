import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromResultQuery,
  migrate,
} from '@toklyn/store/postgres';
import pg from 'pg';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const pool = new pg.Pool({ connectionString: env('POSTGRES_URL') });
  // Prepared statements make rotation faster; leave them off behind transaction-mode poolers.
  const client = fromResultQuery(pool, { prepare: true });
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => pool.end(),
  };
}
