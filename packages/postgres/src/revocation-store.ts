import { systemClock } from 'toklyn';
import type { AccessTokenRevocationStore, Clock } from 'toklyn';
import type { PostgresClient } from '#src/client.js';
import { malformed, parseInteger, toTimestamp } from '#src/codec.js';
import { resolveNames } from '#src/schema.js';
import type { PostgresSchemaOptions } from '#src/schema.js';

export interface PostgresAccessTokenRevocationStoreOptions extends PostgresSchemaOptions {
  client: PostgresClient;
  clock?: Clock;
}

/** Access-token denylist backed by PostgreSQL. Call `purgeExpired` now and then to drop old entries. */
export class PostgresAccessTokenRevocationStore implements AccessTokenRevocationStore {
  private readonly client: PostgresClient;
  private readonly clock: Clock;
  private readonly sql: { revoke: string; isRevoked: string; purge: string };

  constructor({
    client,
    clock = systemClock,
    ...names
  }: PostgresAccessTokenRevocationStoreOptions) {
    this.client = client;
    this.clock = clock;
    const { revocations } = resolveNames(names).tables;
    this.sql = {
      // Keeps the later expiry if the token is revoked twice.
      revoke: `INSERT INTO ${revocations} AS r (jti, expires_at)
VALUES ($1, ${toTimestamp('$2')})
ON CONFLICT (jti) DO UPDATE SET expires_at = GREATEST(r.expires_at, EXCLUDED.expires_at)`,
      isRevoked: `SELECT 1 AS revoked FROM ${revocations}
WHERE jti = $1 AND expires_at > ${toTimestamp('$2')}`,
      purge: `WITH removed AS (
  DELETE FROM ${revocations} WHERE expires_at <= ${toTimestamp('$1')} RETURNING 1
)
SELECT count(*)::text AS removed FROM removed`,
    };
  }

  async revoke(jti: string, expiresAt: number): Promise<void> {
    if (expiresAt <= this.clock.now()) return;
    await this.client.query(this.sql.revoke, [jti, String(expiresAt)]);
  }

  async isRevoked(jti: string): Promise<boolean> {
    const rows = await this.client.query(this.sql.isRevoked, [
      jti,
      String(this.clock.now()),
    ]);
    return rows.length > 0;
  }

  /** Deletes entries whose tokens have expired. Returns how many were removed. */
  async purgeExpired(now: number = this.clock.now()): Promise<number> {
    const [row] = await this.client.query(this.sql.purge, [String(now)]);
    if (!row) throw malformed();
    return parseInteger(row['removed']);
  }
}
