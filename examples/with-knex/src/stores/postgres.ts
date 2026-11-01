import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import knex from 'knex';
import { requireEnv, toPositionalPlaceholders } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const db = knex({ client: 'pg', connection: requireEnv('POSTGRES_URL') });

  // toklyn's SQL runs through knex.raw with bound parameters, on knex's pool.
  const client: PostgresClient = {
    async query(text, params) {
      const { sql, bindings } = toPositionalPlaceholders(text, params);
      const result = await db.raw<{ rows: PostgresRow[] }>(sql, bindings);
      return result.rows;
    },
  };
  // Creates toklyn's tables if missing. In production, run it from a deploy step.
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => db.destroy(),
  };
}
