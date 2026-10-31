import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import postgres from 'postgres';
import type { AccessTokenRevocationStore } from 'toklyn';
import { afterAll } from 'vitest';
import { fromResultQuery, fromUnsafeQuery, migrate } from '#src/index.js';
import type { PostgresClient } from '#src/index.js';

/** Set to run the suites against a real server, e.g. postgres://postgres:postgres@localhost:5432/postgres. */
export const POSTGRES_URL = process.env.POSTGRES_URL;

export interface TestDatabase {
  client: PostgresClient;
  /** A new, migrated schema, so every store starts empty. */
  freshSchema(): Promise<string>;
}

function trackSchemas(client: PostgresClient) {
  const tag = `toklyn_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const created: string[] = [];
  return {
    async freshSchema() {
      const schema = `${tag}_${created.length + 1}`;
      created.push(schema);
      await migrate(client, { schema });
      return schema;
    },
    async dropAll() {
      for (const schema of created) {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, []);
      }
    },
  };
}

/** In-process Postgres (WASM). Needs no server. */
export function usePGlite(): TestDatabase {
  const db = new PGlite();
  const client = fromResultQuery(db);
  const schemas = trackSchemas(client);
  afterAll(() => db.close());
  return { client, freshSchema: schemas.freshSchema };
}

/** node-postgres and postgres.js against `POSTGRES_URL`. Drops its schemas afterwards. */
export function useServer() {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 4 });
  const sql = postgres(POSTGRES_URL ?? '', { max: 4, onnotice: () => {} });
  const viaPool = fromResultQuery(pool);
  const viaUnsafe = fromUnsafeQuery(sql);
  const schemas = trackSchemas(viaPool);

  afterAll(async () => {
    await schemas.dropAll();
    await Promise.all([pool.end(), sql.end()]);
  });

  const db = (client: PostgresClient) => ({
    client,
    freshSchema: schemas.freshSchema,
  });
  return {
    pool: db(viaPool),
    unsafe: db(viaUnsafe),
    poolPrepared: db(fromResultQuery(pool, { prepare: true })),
    unsafePrepared: db(fromUnsafeQuery(sql, { prepare: true })),
  } satisfies Record<string, TestDatabase>;
}

/** The revocation contract wants a synchronous factory; this waits for the schema lazily. */
export function lazyRevocationStore(
  create: () => Promise<AccessTokenRevocationStore>,
): AccessTokenRevocationStore {
  const ready = create();
  return {
    revoke: async (jti, expiresAt) => (await ready).revoke(jti, expiresAt),
    isRevoked: async (jti) => (await ready).isRevoked(jti),
  };
}
