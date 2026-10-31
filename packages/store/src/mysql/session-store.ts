import type {
  NewSession,
  RotateInput,
  RotateResult,
  Session,
  SessionStore,
} from 'toklyn';
import type { MySqlClient, MySqlExecutor } from '#src/mysql/client.js';
import {
  MS,
  checkKey,
  nullableInteger,
  parseInteger,
  parseSession,
  sessionColumns,
} from '#src/mysql/codec.js';
import { resolveTables } from '#src/mysql/schema.js';
import type { MySqlSchemaOptions } from '#src/mysql/schema.js';

export interface MySqlSessionStoreOptions extends MySqlSchemaOptions {
  client: MySqlClient;
}

interface Statements {
  insertSession: string;
  insertToken: string;
  find: string;
  lockToken: string;
  revokeSession: string;
  revokeIn: string;
  consume: string;
  activeForUpdate: string;
  revokeById: string;
  list: string;
  purge: string;
}

/** Deadlock (1213) and lock wait timeout (1205): the transaction was rolled back and can be retried. */
const RETRYABLE_ERRNOS = new Set([1205, 1213]);
const MAX_ATTEMPTS = 3;

/**
 * Session store backed by MySQL 8.0+ or MariaDB 10.6+ (InnoDB). Rotation locks the token and
 * its session in one transaction. Create the tables first with `migrate` or `createSchemaSql`.
 * Claims must be JSON-serializable.
 */
export class MySqlSessionStore implements SessionStore {
  private readonly client: MySqlClient;
  private readonly sql: Statements;

  constructor({ client, ...names }: MySqlSessionStoreOptions) {
    this.client = client;
    this.sql = buildStatements(names);
  }

  async create({ session, refreshToken }: NewSession): Promise<void> {
    checkKey('session id', session.id);
    checkKey('subject', session.subject);
    checkKey('refresh token hash', refreshToken.hash);
    await this.transaction(async (tx) => {
      await tx.query(this.sql.insertSession, [
        session.id,
        session.subject,
        JSON.stringify(session.claims),
        JSON.stringify(session.metadata),
        String(session.createdAt),
        String(session.lastRefreshedAt),
        String(session.expiresAt),
        nullableString(session.revokedAt),
      ]);
      await tx.query(this.sql.insertToken, [
        refreshToken.hash,
        refreshToken.sessionId,
        String(refreshToken.issuedAt),
        String(refreshToken.expiresAt),
        nullableString(refreshToken.consumedAt),
      ]);
    });
  }

  async find(sessionId: string): Promise<Session | null> {
    const { rows } = await this.client.query(this.sql.find, [sessionId]);
    const [row] = rows;
    return row ? parseSession(row) : null;
  }

  async rotate(input: RotateInput): Promise<RotateResult> {
    const { presentedHash, newHash, now, refreshTtlMs, reuseGraceMs, claims } =
      input;
    checkKey('refresh token hash', newHash);
    const claimsJson = claims ? JSON.stringify(claims) : null;

    return this.transaction(async (tx): Promise<RotateResult> => {
      // Locks the token and its session; a concurrent rotation waits, then sees it consumed.
      const [row] = (await tx.query(this.sql.lockToken, [presentedHash])).rows;
      if (!row) return { status: 'unknown_token' };
      const session = parseSession(row);
      const tokenExpiresAt = parseInteger(row['token_expires_at']);
      const consumedAt = nullableInteger(row['token_consumed_at']);

      if (session.revokedAt !== null) {
        return { status: 'session_revoked', session };
      }
      if (now >= session.expiresAt) {
        return { status: 'session_expired', session };
      }
      if (
        consumedAt !== null &&
        !(reuseGraceMs > 0 && now - consumedAt <= reuseGraceMs)
      ) {
        await tx.query(this.sql.revokeSession, [String(now), session.id]);
        return {
          status: 'reuse_detected',
          session: { ...session, revokedAt: now },
        };
      }
      if (now >= tokenExpiresAt) return { status: 'token_expired' };

      const successor = {
        hash: newHash,
        sessionId: session.id,
        issuedAt: now,
        expiresAt: Math.min(now + refreshTtlMs, session.expiresAt),
        consumedAt: null,
      };
      await tx.query(this.sql.consume, [
        String(now),
        String(now),
        claimsJson,
        presentedHash,
      ]);
      await tx.query(this.sql.insertToken, [
        successor.hash,
        successor.sessionId,
        String(successor.issuedAt),
        String(successor.expiresAt),
        null,
      ]);
      return {
        status: 'rotated',
        session: {
          ...session,
          lastRefreshedAt: now,
          claims:
            claimsJson === null
              ? session.claims
              : (JSON.parse(claimsJson) as Session['claims']),
        },
        refreshToken: successor,
      };
    });
  }

  async revoke(sessionId: string, now: number): Promise<Session | null> {
    return this.transaction(async (tx) => {
      await tx.query(this.sql.revokeById, [String(now), sessionId]);
      const [row] = (await tx.query(this.sql.find, [sessionId])).rows;
      return row ? parseSession(row) : null;
    });
  }

  async revokeAllForSubject(subject: string, now: number): Promise<Session[]> {
    return this.transaction(async (tx) => {
      const { rows } = await tx.query(this.sql.activeForUpdate, [
        subject,
        String(now),
      ]);
      const sessions = rows.map(parseSession);
      if (sessions.length === 0) return [];
      const placeholders = sessions.map(() => '?').join(', ');
      await tx.query(`${this.sql.revokeIn} (${placeholders})`, [
        String(now),
        ...sessions.map((s) => s.id),
      ]);
      return sessions.map((s) => ({ ...s, revokedAt: now }));
    });
  }

  async listForSubject(subject: string, now: number): Promise<Session[]> {
    const { rows } = await this.client.query(this.sql.list, [
      subject,
      String(now),
    ]);
    return rows.map(parseSession);
  }

  /** Deletes expired sessions; their refresh tokens go with them. */
  async purgeExpired(now: number): Promise<number> {
    const { affectedRows } = await this.client.query(this.sql.purge, [
      String(now),
    ]);
    return affectedRows;
  }

  private async transaction<T>(
    fn: (tx: MySqlExecutor) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.client.transaction(fn);
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      }
    }
  }
}

function isRetryable(error: unknown): boolean {
  const errno = (error as { errno?: unknown } | null)?.errno;
  return typeof errno === 'number' && RETRYABLE_ERRNOS.has(errno);
}

function nullableString(value: number | null): string | null {
  return value === null ? null : String(value);
}

function buildStatements(options: MySqlSchemaOptions): Statements {
  const { sessions, refreshTokens } = resolveTables(options);
  const active = `revoked_at IS NULL AND expires_at > ${MS}`;

  return {
    insertSession: `INSERT INTO ${sessions}
  (id, subject, claims, metadata, created_at, last_refreshed_at, expires_at, revoked_at)
VALUES (?, ?, ?, ?, ${MS}, ${MS}, ${MS}, ${MS})`,

    insertToken: `INSERT INTO ${refreshTokens}
  (hash, session_id, issued_at, expires_at, consumed_at)
VALUES (?, ?, ${MS}, ${MS}, ${MS})`,

    find: `SELECT ${sessionColumns()} FROM ${sessions} WHERE id = ?`,

    lockToken: `SELECT ${sessionColumns('s.')},
  CAST(t.expires_at AS CHAR) AS token_expires_at,
  CAST(t.consumed_at AS CHAR) AS token_consumed_at
FROM ${refreshTokens} t JOIN ${sessions} s ON s.id = t.session_id
WHERE t.hash = ? FOR UPDATE`,

    revokeSession: `UPDATE ${sessions} SET revoked_at = ${MS} WHERE id = ?`,

    // Completed with the locked ids.
    revokeIn: `UPDATE ${sessions} SET revoked_at = ${MS} WHERE id IN`,

    // A replay inside the grace window keeps the first consumption time.
    consume: `UPDATE ${refreshTokens} t JOIN ${sessions} s ON s.id = t.session_id
SET t.consumed_at = COALESCE(t.consumed_at, ${MS}),
  s.last_refreshed_at = ${MS},
  s.claims = COALESCE(?, s.claims)
WHERE t.hash = ?`,

    activeForUpdate: `SELECT ${sessionColumns()} FROM ${sessions}
WHERE subject = ? AND ${active} FOR UPDATE`,

    revokeById: `UPDATE ${sessions} SET revoked_at = COALESCE(revoked_at, ${MS}) WHERE id = ?`,

    list: `SELECT ${sessionColumns()} FROM ${sessions}
WHERE subject = ? AND ${active} ORDER BY created_at, id`,

    purge: `DELETE FROM ${sessions} WHERE expires_at <= ${MS}`,
  };
}
