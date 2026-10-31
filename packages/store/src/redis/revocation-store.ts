import { systemClock } from 'toklyn';
import type { AccessTokenRevocationStore, Clock } from 'toklyn';
import type { RedisClient } from '#src/redis/client.js';
import { parseTimestamp } from '#src/redis/codec.js';
import {
  GET_ACCESS_TOKEN_REVOCATION,
  REVOKE_ACCESS_TOKEN,
} from '#src/redis/scripts.js';
import { DEFAULT_KEY_PREFIX } from '#src/redis/session-store.js';

export interface RedisAccessTokenRevocationStoreOptions {
  client: RedisClient;
  keyPrefix?: string;
  clock?: Clock;
}

/** Access-token denylist backed by Redis. Entries expire on their own once the token would have. */
export class RedisAccessTokenRevocationStore implements AccessTokenRevocationStore {
  private readonly client: RedisClient;
  private readonly prefix: string;
  private readonly clock: Clock;

  constructor({
    client,
    keyPrefix = DEFAULT_KEY_PREFIX,
    clock = systemClock,
  }: RedisAccessTokenRevocationStoreOptions) {
    this.client = client;
    this.prefix = keyPrefix;
    this.clock = clock;
  }

  async revoke(jti: string, expiresAt: number): Promise<void> {
    const ttl = expiresAt - this.clock.now();
    if (ttl <= 0) return;
    await this.client.eval(
      REVOKE_ACCESS_TOKEN,
      [this.key(jti)],
      [String(expiresAt), String(ttl)],
    );
  }

  async isRevoked(jti: string): Promise<boolean> {
    const reply = await this.client.eval(
      GET_ACCESS_TOKEN_REVOCATION,
      [this.key(jti)],
      [],
    );
    if (reply === null) return false;
    return parseTimestamp(reply) > this.clock.now();
  }

  private key(jti: string): string {
    return `${this.prefix}r:${jti}`;
  }
}
