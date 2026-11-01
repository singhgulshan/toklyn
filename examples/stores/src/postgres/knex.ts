import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import knex from 'knex';
import { env, toPositionalPlaceholders } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const db = knex({ client: 'pg', connection: env('POSTGRES_URL') });

  const client: PostgresClient = {
    async query(text, params) {
      // knex.raw binds `?` placeholders; it turns them back into $1, $2, ... for PostgreSQL.
      const { sql, bindings } = toPositionalPlaceholders(text, params);
      const result = await db.raw<{ rows: PostgresRow[] }>(sql, bindings);
      return result.rows;
    },
  };
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => db.destroy(),
  };
}
