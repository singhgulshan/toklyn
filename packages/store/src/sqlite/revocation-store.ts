import { systemClock } from 'toklyn';
import type { AccessTokenRevocationStore, Clock } from 'toklyn';
import { retryWhenBusy } from '#src/sqlite/busy.js';
import type { SqliteExecutor } from '#src/sqlite/client.js';
import { MS } from '#src/sqlite/codec.js';
import { resolveTables } from '#src/sqlite/schema.js';
import type { SqliteSchemaOptions } from '#src/sqlite/schema.js';

export interface SqliteAccessTokenRevocationStoreOptions extends SqliteSchemaOptions {
  client: SqliteExecutor;
  clock?: Clock;
}

/** Access-token denylist backed by SQLite. Call `purgeExpired` now and then to drop old entries. */
export class SqliteAccessTokenRevocationStore implements AccessTokenRevocationStore {
  private readonly client: SqliteExecutor;
  private readonly clock: Clock;
  private readonly sql: { revoke: string; isRevoked: string; purge: string };

  constructor({
    client,
    clock = systemClock,
    ...names
  }: SqliteAccessTokenRevocationStoreOptions) {
    this.client = client;
    this.clock = clock;
    const { revocations } = resolveTables(names);
    this.sql = {
      // Keeps the later expiry if the token is revoked twice.
      revoke: `INSERT INTO ${revocations} (jti, expires_at) VALUES (?, ${MS})
ON CONFLICT (jti) DO UPDATE SET expires_at = max(expires_at, excluded.expires_at)`,
      isRevoked: `SELECT 1 AS revoked FROM ${revocations}
WHERE jti = ? AND expires_at > ${MS}`,
      purge: `DELETE FROM ${revocations} WHERE expires_at <= ${MS}`,
    };
  }

  async revoke(jti: string, expiresAt: number): Promise<void> {
    if (expiresAt <= this.clock.now()) return;
    await retryWhenBusy(() =>
      this.client.run(this.sql.revoke, [jti, String(expiresAt)]),
    );
  }

  async isRevoked(jti: string): Promise<boolean> {
    const rows = await retryWhenBusy(() =>
      this.client.all(this.sql.isRevoked, [jti, String(this.clock.now())]),
    );
    return rows.length > 0;
  }

  /** Deletes entries whose tokens have expired. Returns how many were removed. */
  async purgeExpired(now: number = this.clock.now()): Promise<number> {
    return retryWhenBusy(() => this.client.run(this.sql.purge, [String(now)]));
  }
}
