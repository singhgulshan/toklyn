import { ToklynError } from 'toklyn';
import type { MongoCollection, MongoDatabase } from '#src/mongodb/client.js';

export interface MongoSchemaOptions {
  /** Prefix for collection names. Default `toklyn_`. */
  collectionPrefix?: string;
}

export const DEFAULT_COLLECTION_PREFIX = 'toklyn_';

// Same limit as the SQL stores' table prefix.
const MAX_PREFIX_LENGTH = 24;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface Collections {
  sessions: MongoCollection;
  revocations: MongoCollection;
}

export function resolveCollections(
  db: MongoDatabase,
  { collectionPrefix = DEFAULT_COLLECTION_PREFIX }: MongoSchemaOptions = {},
): Collections {
  if (
    collectionPrefix !== '' &&
    !(
      IDENTIFIER.test(collectionPrefix) &&
      collectionPrefix.length <= MAX_PREFIX_LENGTH
    )
  ) {
    throw new ToklynError(
      'invalid_config',
      `collectionPrefix must be at most ${MAX_PREFIX_LENGTH} lowercase letters, digits or underscores, not starting with a digit`,
    );
  }
  return {
    sessions: db.collection(`${collectionPrefix}sessions`),
    revocations: db.collection(`${collectionPrefix}access_token_revocations`),
  };
}

/**
 * Creates the indexes the stores rely on, including the unique index on refresh-token hashes.
 * Safe to run more than once. Expired documents are deleted by MongoDB's TTL monitor.
 */
export async function migrate(
  db: MongoDatabase,
  options?: MongoSchemaOptions,
): Promise<void> {
  const { sessions, revocations } = resolveCollections(db, options);
  await sessions.createIndex(
    { 'tokens.hash': 1 },
    { name: 'tokens_hash', unique: true },
  );
  await sessions.createIndex({ subject: 1 }, { name: 'subject' });
  await sessions.createIndex(
    { expireAt: 1 },
    { name: 'expire_at', expireAfterSeconds: 0 },
  );
  await revocations.createIndex(
    { expireAt: 1 },
    { name: 'expire_at', expireAfterSeconds: 0 },
  );
}
