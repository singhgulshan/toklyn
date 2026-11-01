import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import type { AccessTokenRevocationStore } from 'toklyn';
import { afterAll } from 'vitest';
import { migrate } from '#src/mongodb/index.js';
import type { MongoDatabase } from '#src/mongodb/index.js';

/** Set to run the suites against a real server, e.g. mongodb://localhost:27017. */
export const MONGODB_URL = process.env.MONGODB_URL;

export interface TestDatabase {
  db: MongoDatabase;
  /** A new, migrated collection prefix, so every store starts empty. */
  freshPrefix(): Promise<string>;
}

/** A throwaway database, dropped after the test file. */
export function useMongo(url: string): TestDatabase {
  const client = new MongoClient(url);
  const db = client.db(
    `toklyn_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
  );
  let prefixes = 0;

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  return {
    db,
    async freshPrefix() {
      prefixes += 1;
      const collectionPrefix = `t${prefixes}_`;
      await migrate(db, { collectionPrefix });
      return collectionPrefix;
    },
  };
}

/** The revocation contract wants a synchronous factory; this waits for the indexes lazily. */
export function lazyRevocationStore(
  create: () => Promise<AccessTokenRevocationStore>,
): AccessTokenRevocationStore {
  const ready = create();
  return {
    revoke: async (jti, expiresAt) => (await ready).revoke(jti, expiresAt),
    isRevoked: async (jti) => (await ready).isRevoked(jti),
  };
}
