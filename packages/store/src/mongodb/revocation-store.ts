import { systemClock } from 'toklyn';
import type { AccessTokenRevocationStore, Clock } from 'toklyn';
import type { MongoCollection, MongoDatabase } from '#src/mongodb/client.js';
import { checkString } from '#src/mongodb/codec.js';
import { resolveCollections } from '#src/mongodb/schema.js';
import type { MongoSchemaOptions } from '#src/mongodb/schema.js';

export interface MongoAccessTokenRevocationStoreOptions extends MongoSchemaOptions {
  db: MongoDatabase;
  clock?: Clock;
}

/** Access-token denylist backed by MongoDB. Entries are deleted by the TTL index once the token expires. */
export class MongoAccessTokenRevocationStore implements AccessTokenRevocationStore {
  private readonly revocations: MongoCollection;
  private readonly clock: Clock;

  constructor({
    db,
    clock = systemClock,
    ...names
  }: MongoAccessTokenRevocationStoreOptions) {
    this.revocations = resolveCollections(db, names).revocations;
    this.clock = clock;
  }

  async revoke(jti: string, expiresAt: number): Promise<void> {
    checkString('token id', jti);
    if (expiresAt <= this.clock.now()) return;
    // Keeps the later expiry if the token is revoked twice.
    await this.revocations.updateOne(
      { _id: jti },
      { $max: { expiresAt, expireAt: new Date(expiresAt) } },
      { upsert: true },
    );
  }

  async isRevoked(jti: string): Promise<boolean> {
    checkString('token id', jti);
    const document = await this.revocations.findOne(
      { _id: jti, expiresAt: { $gt: this.clock.now() } },
      { projection: { _id: 1 } },
    );
    return document !== null;
  }

  /** Deletes entries whose tokens have expired. Returns how many were removed. */
  async purgeExpired(now: number = this.clock.now()): Promise<number> {
    const { deletedCount } = await this.revocations.deleteMany({
      expiresAt: { $lte: now },
    });
    return deletedCount;
  }
}
