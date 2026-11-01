import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromUnsafeQuery,
  migrate,
} from '@toklyn/store/postgres';
import postgres from 'postgres';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  // `migrate` uses CREATE ... IF NOT EXISTS, which raises "already exists" notices.
  const sql = postgres(env('POSTGRES_URL'), { onnotice: () => {} });
  const client = fromUnsafeQuery(sql, { prepare: true });
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => sql.end(),
  };
}
