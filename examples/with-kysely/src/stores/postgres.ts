import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';
import type { Database } from './database.js';

export async function connect(): Promise<Stores> {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: requireEnv('POSTGRES_URL') }),
    }),
  });

  // toklyn's SQL runs as raw, parameterized queries on Kysely's pool.
  const client: PostgresClient = {
    async query(text, params) {
      const result = await db.executeQuery(
        CompiledQuery.raw(text, [...params]),
      );
      return result.rows as PostgresRow[];
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
