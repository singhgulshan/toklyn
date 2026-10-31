import type {
  NewSession,
  RotateInput,
  RotateResult,
  Session,
  SessionStore,
} from 'toklyn';
import type { PostgresClient } from '#src/postgres/client.js';
import {
  SESSION_COLUMNS,
  malformed,
  parseInteger,
  parseSession,
  text,
  toEpochMs,
  toTimestamp,
} from '#src/postgres/codec.js';
import { resolveNames } from '#src/postgres/schema.js';
import type { PostgresSchemaOptions } from '#src/postgres/schema.js';

export interface PostgresSessionStoreOptions extends PostgresSchemaOptions {
  client: PostgresClient;
}

interface Statements {
  create: string;
  find: string;
  rotate: string;
  revoke: string;
  revokeAll: string;
  list: string;
  purge: string;
}

/**
 * Session store backed by PostgreSQL. Every operation is one statement, so rotation is
 * atomic without transactions and works with serverless HTTP drivers. Create the tables
 * first with `migrate` or `createSchemaSql`. Claims must be JSON-serializable.
 */
export class PostgresSessionStore implements SessionStore {
  private readonly client: PostgresClient;
  private readonly sql: Statements;

  constructor({ client, ...names }: PostgresSessionStoreOptions) {
    this.client = client;
    this.sql = buildStatements(names);
  }

  async create({ session, refreshToken }: NewSession): Promise<void> {
    await this.client.query(this.sql.create, [
      session.id,
      session.subject,
      JSON.stringify(session.claims),
      JSON.stringify(session.metadata),
      String(session.createdAt),
      String(session.lastRefreshedAt),
      String(session.expiresAt),
      nullableTimestamp(session.revokedAt),
      refreshToken.hash,
      refreshToken.sessionId,
      String(refreshToken.issuedAt),
      String(refreshToken.expiresAt),
      nullableTimestamp(refreshToken.consumedAt),
    ]);
  }

  async find(sessionId: string): Promise<Session | null> {
    const [row] = await this.client.query(this.sql.find, [sessionId]);
    return row ? parseSession(row) : null;
  }

  async rotate(input: RotateInput): Promise<RotateResult> {
    const { presentedHash, newHash, now, refreshTtlMs, reuseGraceMs, claims } =
      input;
    const [row] = await this.client.query(this.sql.rotate, [
      presentedHash,
      newHash,
      String(now),
      String(refreshTtlMs),
      String(reuseGraceMs),
      claims ? JSON.stringify(claims) : null,
    ]);
    if (!row) return { status: 'unknown_token' };

    const status = text(row, 'status');
    switch (status) {
      case 'token_expired':
        return { status };
      case 'session_expired':
      case 'session_revoked':
      case 'reuse_detected':
        return { status, session: parseSession(row) };
      case 'rotated': {
        const session = parseSession(row);
        return {
          status,
          session,
          refreshToken: {
            hash: newHash,
            sessionId: session.id,
            issuedAt: now,
            expiresAt: parseInteger(row['token_expires_at']),
            consumedAt: null,
          },
        };
      }
      default:
        throw malformed();
    }
  }

  async revoke(sessionId: string, now: number): Promise<Session | null> {
    const [row] = await this.client.query(this.sql.revoke, [
      sessionId,
      String(now),
    ]);
    return row ? parseSession(row) : null;
  }

  async revokeAllForSubject(subject: string, now: number): Promise<Session[]> {
    const rows = await this.client.query(this.sql.revokeAll, [
      subject,
      String(now),
    ]);
    return rows.map(parseSession);
  }

  async listForSubject(subject: string, now: number): Promise<Session[]> {
    const rows = await this.client.query(this.sql.list, [subject, String(now)]);
    return rows.map(parseSession);
  }

  /** Deletes expired sessions; their refresh tokens go with them. */
  async purgeExpired(now: number): Promise<number> {
    const [row] = await this.client.query(this.sql.purge, [String(now)]);
    if (!row) throw malformed();
    return parseInteger(row['removed']);
  }
}

function nullableTimestamp(value: number | null): string | null {
  return value === null ? null : String(value);
}

function buildStatements(options: PostgresSchemaOptions): Statements {
  // Params are typed as text before casting, else some drivers JSON-encode strings bound to jsonb.
  const { sessions, refreshTokens } = resolveNames(options).tables;
  const active = (now: string) =>
    `revoked_at IS NULL AND expires_at > ${toTimestamp(now)}`;

  return {
    create: `WITH new_session AS (
  INSERT INTO ${sessions}
    (id, subject, claims, metadata, created_at, last_refreshed_at, expires_at, revoked_at)
  VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, ${toTimestamp('$5')}, ${toTimestamp('$6')},
    ${toTimestamp('$7')}, ${toTimestamp('$8')})
  RETURNING id
)
INSERT INTO ${refreshTokens} (hash, session_id, issued_at, expires_at, consumed_at)
SELECT $9, $10, ${toTimestamp('$11')}, ${toTimestamp('$12')}, ${toTimestamp('$13')}
FROM new_session`,

    find: `SELECT ${SESSION_COLUMNS} FROM ${sessions} WHERE id = $1`,

    // Locks the token, then its session; a concurrent rotation of the same token waits
    // and then sees it consumed. The writes below are mutually exclusive by status.
    rotate: `WITH params AS (
  SELECT ${toTimestamp('$3')} AS now,
    $4::bigint * interval '1 millisecond' AS ttl,
    $5::bigint AS grace_ms,
    $5::bigint * interval '1 millisecond' AS grace
),
locked_token AS (
  SELECT session_id, expires_at, consumed_at FROM ${refreshTokens}
  WHERE hash = $1 FOR UPDATE
),
locked_session AS (
  SELECT s.* FROM ${sessions} s JOIN locked_token t ON s.id = t.session_id
  FOR UPDATE OF s
),
decision AS (
  SELECT s.id AS session_id, s.expires_at AS session_expires_at,
    CASE
      WHEN s.revoked_at IS NOT NULL THEN 'session_revoked'
      WHEN p.now >= s.expires_at THEN 'session_expired'
      WHEN t.consumed_at IS NOT NULL
        AND (p.grace_ms <= 0 OR p.now - t.consumed_at > p.grace) THEN 'reuse_detected'
      WHEN p.now >= t.expires_at THEN 'token_expired'
      ELSE 'rotated'
    END AS status
  FROM locked_token t JOIN locked_session s ON s.id = t.session_id
  CROSS JOIN params p
),
revoked AS (
  UPDATE ${sessions} AS s SET revoked_at = p.now
  FROM decision d, params p
  WHERE s.id = d.session_id AND d.status = 'reuse_detected'
  RETURNING s.*
),
consumed AS (
  UPDATE ${refreshTokens} AS t SET consumed_at = p.now
  FROM decision d, params p
  WHERE t.hash = $1 AND t.consumed_at IS NULL AND d.status = 'rotated'
),
refreshed AS (
  UPDATE ${sessions} AS s
  SET last_refreshed_at = p.now, claims = COALESCE($6::text::jsonb, s.claims)
  FROM decision d, params p
  WHERE s.id = d.session_id AND d.status = 'rotated'
  RETURNING s.*
),
successor AS (
  INSERT INTO ${refreshTokens} (hash, session_id, issued_at, expires_at, consumed_at)
  SELECT $2, d.session_id, p.now, LEAST(p.now + p.ttl, d.session_expires_at), NULL
  FROM decision d, params p WHERE d.status = 'rotated'
  RETURNING expires_at
)
SELECT 'rotated' AS status, ${SESSION_COLUMNS},
  (SELECT ${toEpochMs('expires_at')} FROM successor) AS token_expires_at
FROM refreshed
UNION ALL
SELECT 'reuse_detected', ${SESSION_COLUMNS}, NULL FROM revoked
UNION ALL
SELECT d.status, ${SESSION_COLUMNS}, NULL
FROM decision d JOIN locked_session s ON s.id = d.session_id
WHERE d.status IN ('session_revoked', 'session_expired', 'token_expired')`,

    revoke: `UPDATE ${sessions} SET revoked_at = COALESCE(revoked_at, ${toTimestamp('$2')})
WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,

    revokeAll: `UPDATE ${sessions} SET revoked_at = ${toTimestamp('$2')}
WHERE subject = $1 AND ${active('$2')} RETURNING ${SESSION_COLUMNS}`,

    list: `SELECT ${SESSION_COLUMNS} FROM ${sessions}
WHERE subject = $1 AND ${active('$2')} ORDER BY created_at, id`,

    purge: `WITH removed AS (
  DELETE FROM ${sessions} WHERE expires_at <= ${toTimestamp('$1')} RETURNING 1
)
SELECT count(*)::text AS removed FROM removed`,
  };
}
