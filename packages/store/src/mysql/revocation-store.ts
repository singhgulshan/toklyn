import { systemClock } from 'toklyn';
import type { AccessTokenRevocationStore, Clock } from 'toklyn';
import type { MySqlExecutor } from '#src/mysql/client.js';
import { MS, checkKey } from '#src/mysql/codec.js';
import { resolveTables } from '#src/mysql/schema.js';
import type { MySqlSchemaOptions } from '#src/mysql/schema.js';

export interface MySqlAccessTokenRevocationStoreOptions extends MySqlSchemaOptions {
  client: MySqlExecutor;
  clock?: Clock;
}

/** Access-token denylist backed by MySQL or MariaDB. Call `purgeExpired` now and then to drop old entries. */
export class MySqlAccessTokenRevocationStore implements AccessTokenRevocationStore {
  private readonly client: MySqlExecutor;
  private readonly clock: Clock;
  private readonly sql: { revoke: string; isRevoked: string; purge: string };

  constructor({
    client,
    clock = systemClock,
    ...names
  }: MySqlAccessTokenRevocationStoreOptions) {
    this.client = client;
    this.clock = clock;
    const { revocations } = resolveTables(names);
    this.sql = {
      // Keeps the later expiry if the token is revoked twice.
      revoke: `INSERT INTO ${revocations} (jti, expires_at) VALUES (?, ${MS})
ON DUPLICATE KEY UPDATE expires_at = GREATEST(expires_at, ${MS})`,
      isRevoked: `SELECT 1 AS revoked FROM ${revocations}
WHERE jti = ? AND expires_at > ${MS}`,
      purge: `DELETE FROM ${revocations} WHERE expires_at <= ${MS}`,
    };
  }

  async revoke(jti: string, expiresAt: number): Promise<void> {
    // A truncated jti would never match, leaving the token usable.
    checkKey('token id', jti);
    if (expiresAt <= this.clock.now()) return;
    const expires = String(expiresAt);
    await this.client.query(this.sql.revoke, [jti, expires, expires]);
  }

  async isRevoked(jti: string): Promise<boolean> {
    const { rows } = await this.client.query(this.sql.isRevoked, [
      jti,
      String(this.clock.now()),
    ]);
    return rows.length > 0;
  }

  /** Deletes entries whose tokens have expired. Returns how many were removed. */
  async purgeExpired(now: number = this.clock.now()): Promise<number> {
    const { affectedRows } = await this.client.query(this.sql.purge, [
      String(now),
    ]);
    return affectedRows;
  }
}
