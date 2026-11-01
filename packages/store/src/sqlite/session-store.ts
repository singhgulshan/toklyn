import type {
  NewSession,
  RotateInput,
  RotateResult,
  Session,
  SessionStore,
} from 'toklyn';
import { retryWhenBusy } from '#src/sqlite/busy.js';
import type { SqliteClient, SqliteExecutor } from '#src/sqlite/client.js';
import {
  MS,
  nullableInteger,
  nullableString,
  parseInteger,
  parseSession,
  sessionColumns,
} from '#src/sqlite/codec.js';
import { resolveTables } from '#src/sqlite/schema.js';
import type { SqliteSchemaOptions } from '#src/sqlite/schema.js';

export interface SqliteSessionStoreOptions extends SqliteSchemaOptions {
  client: SqliteClient;
}

interface Statements {
  insertSession: string;
  insertToken: string;
  find: string;
  tokenWithSession: string;
  revokeSession: string;
  consumeToken: string;
  touchSession: string;
  revokeById: string;
  revokeAll: string;
  list: string;
  purgeTokens: string;
  purgeSessions: string;
}

/**
 * Session store backed by SQLite 3.37+. Rotation runs in a `BEGIN IMMEDIATE` transaction, which
 * holds the database write lock, so concurrent rotations run one after another. Create the
 * tables first with `migrate` or `createSchemaSql`. Claims must be JSON-serializable.
 */
export class SqliteSessionStore implements SessionStore {
  private readonly client: SqliteClient;
  private readonly sql: Statements;

  constructor({ client, ...names }: SqliteSessionStoreOptions) {
    this.client = client;
    this.sql = buildStatements(names);
  }

  async create({ session, refreshToken }: NewSession): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.run(this.sql.insertSession, [
        session.id,
        session.subject,
        JSON.stringify(session.claims),
        JSON.stringify(session.metadata),
        String(session.createdAt),
        String(session.lastRefreshedAt),
        String(session.expiresAt),
        nullableString(session.revokedAt),
      ]);
      await tx.run(this.sql.insertToken, [
        refreshToken.hash,
        refreshToken.sessionId,
        String(refreshToken.issuedAt),
        String(refreshToken.expiresAt),
        nullableString(refreshToken.consumedAt),
      ]);
    });
  }

  async find(sessionId: string): Promise<Session | null> {
    const [row] = await retryWhenBusy(() =>
      this.client.all(this.sql.find, [sessionId]),
    );
    return row ? parseSession(row) : null;
  }

  async rotate(input: RotateInput): Promise<RotateResult> {
    const { presentedHash, newHash, now, refreshTtlMs, reuseGraceMs, claims } =
      input;
    const claimsJson = claims ? JSON.stringify(claims) : null;

    return this.transaction(async (tx): Promise<RotateResult> => {
      // The transaction already holds the write lock, so nothing changes between read and write.
      const [row] = await tx.all(this.sql.tokenWithSession, [presentedHash]);
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
        await tx.run(this.sql.revokeSession, [String(now), session.id]);
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
      await tx.run(this.sql.consumeToken, [String(now), presentedHash]);
      await tx.run(this.sql.touchSession, [
        String(now),
        claimsJson,
        session.id,
      ]);
      await tx.run(this.sql.insertToken, [
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
    const [row] = await retryWhenBusy(() =>
      this.client.all(this.sql.revokeById, [String(now), sessionId]),
    );
    return row ? parseSession(row) : null;
  }

  async revokeAllForSubject(subject: string, now: number): Promise<Session[]> {
    const rows = await retryWhenBusy(() =>
      this.client.all(this.sql.revokeAll, [String(now), subject, String(now)]),
    );
    return rows
      .map(parseSession)
      .sort((a, b) => a.createdAt - b.createdAt || compare(a.id, b.id));
  }

  async listForSubject(subject: string, now: number): Promise<Session[]> {
    const rows = await retryWhenBusy(() =>
      this.client.all(this.sql.list, [subject, String(now)]),
    );
    return rows.map(parseSession);
  }

  /** Deletes expired sessions and their refresh tokens. Returns how many sessions were removed. */
  async purgeExpired(now: number): Promise<number> {
    return this.transaction(async (tx) => {
      await tx.run(this.sql.purgeTokens, [String(now)]);
      return tx.run(this.sql.purgeSessions, [String(now)]);
    });
  }

  private transaction<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    return retryWhenBusy(() => this.client.transaction(fn));
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildStatements(options: SqliteSchemaOptions): Statements {
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

    tokenWithSession: `SELECT ${sessionColumns('s.')},
  CAST(t.expires_at AS TEXT) AS token_expires_at,
  CAST(t.consumed_at AS TEXT) AS token_consumed_at
FROM ${refreshTokens} t JOIN ${sessions} s ON s.id = t.session_id
WHERE t.hash = ?`,

    revokeSession: `UPDATE ${sessions} SET revoked_at = ${MS} WHERE id = ?`,

    // A replay inside the grace window keeps the first consumption time.
    consumeToken: `UPDATE ${refreshTokens}
SET consumed_at = COALESCE(consumed_at, ${MS}) WHERE hash = ?`,

    touchSession: `UPDATE ${sessions}
SET last_refreshed_at = ${MS}, claims = COALESCE(?, claims) WHERE id = ?`,

    revokeById: `UPDATE ${sessions} SET revoked_at = COALESCE(revoked_at, ${MS})
WHERE id = ? RETURNING ${sessionColumns()}`,

    revokeAll: `UPDATE ${sessions} SET revoked_at = ${MS}
WHERE subject = ? AND ${active} RETURNING ${sessionColumns()}`,

    list: `SELECT ${sessionColumns()} FROM ${sessions}
WHERE subject = ? AND ${active} ORDER BY created_at, id`,

    purgeTokens: `DELETE FROM ${refreshTokens} WHERE session_id IN
  (SELECT id FROM ${sessions} WHERE expires_at <= ${MS})`,

    purgeSessions: `DELETE FROM ${sessions} WHERE expires_at <= ${MS}`,
  };
}
