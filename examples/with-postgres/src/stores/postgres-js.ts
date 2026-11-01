import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromUnsafeQuery,
  migrate,
} from '@toklyn/store/postgres';
import postgres from 'postgres';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  // `migrate` uses CREATE ... IF NOT EXISTS, which raises "already exists" notices.
  const sql = postgres(requireEnv('POSTGRES_URL'), { onnotice: () => {} });
  const client = fromUnsafeQuery(sql, { prepare: true });
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => sql.end(),
  };
}
