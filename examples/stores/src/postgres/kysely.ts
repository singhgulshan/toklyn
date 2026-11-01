import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import { CompiledQuery, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

// Your app's table types; toklyn's tables need none.
interface Database {
  users: { id: string; role: string };
}

export async function connect(): Promise<StoreExample> {
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: env('POSTGRES_URL') }),
    }),
  });

  const client: PostgresClient = {
    async query(text, params) {
      const result = await db.executeQuery(
        CompiledQuery.raw(text, [...params]),
      );
      return result.rows as PostgresRow[];
    },
  };
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => db.destroy(),
  };
}
