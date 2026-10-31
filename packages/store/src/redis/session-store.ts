import { ToklynError } from 'toklyn';
import type {
  NewSession,
  RotateInput,
  RotateResult,
  Session,
  SessionStore,
} from 'toklyn';
import type { RedisClient } from '#src/redis/client.js';
import {
  malformed,
  parseSession,
  parseSessionList,
  parseTimestamp,
  serializeTimestamp,
} from '#src/redis/codec.js';
import {
  ACTIVE_FOR_SUBJECT,
  CREATE_SESSION,
  FIND_SESSION,
  REVOKE_SESSION,
  ROTATE,
} from '#src/redis/scripts.js';

/** The braces are a Redis Cluster hash tag: every key lands in one slot, as the scripts require. */
export const DEFAULT_KEY_PREFIX = '{toklyn}:';

export interface RedisSessionStoreOptions {
  client: RedisClient;
  keyPrefix?: string;
}

/**
 * Session store backed by Redis 6.2+, Valkey or Upstash. Every operation is one Lua script,
 * so rotation is atomic. Keys expire with their session; claims must be JSON-serializable.
 */
export class RedisSessionStore implements SessionStore {
  private readonly client: RedisClient;
  private readonly prefix: string;

  constructor({
    client,
    keyPrefix = DEFAULT_KEY_PREFIX,
  }: RedisSessionStoreOptions) {
    this.client = client;
    this.prefix = keyPrefix;
  }

  async create({ session, refreshToken }: NewSession): Promise<void> {
    const ttl = Math.max(1, session.expiresAt - session.createdAt);
    const created = await this.client.eval(
      CREATE_SESSION,
      [
        this.sessionKey(session.id),
        this.tokenKey(refreshToken.hash),
        this.subjectKey(session.subject),
      ],
      [
        session.id,
        session.subject,
        JSON.stringify(session.claims),
        JSON.stringify(session.metadata),
        String(session.createdAt),
        String(session.expiresAt),
        serializeTimestamp(session.revokedAt),
        refreshToken.sessionId,
        String(refreshToken.issuedAt),
        String(refreshToken.expiresAt),
        serializeTimestamp(refreshToken.consumedAt),
        String(ttl),
        String(session.lastRefreshedAt),
      ],
    );
    if (created !== 1) {
      throw new ToklynError('storage_error', 'Session or token already exists');
    }
  }

  async find(sessionId: string): Promise<Session | null> {
    return parseSession(
      await this.client.eval(FIND_SESSION, [this.sessionKey(sessionId)], []),
    );
  }

  async rotate(input: RotateInput): Promise<RotateResult> {
    const { presentedHash, newHash, now, refreshTtlMs, reuseGraceMs, claims } =
      input;
    const reply = await this.client.eval(
      ROTATE,
      [this.tokenKey(presentedHash), this.tokenKey(newHash)],
      [
        this.prefix,
        String(now),
        String(refreshTtlMs),
        String(reuseGraceMs),
        claims ? '1' : '0',
        claims ? JSON.stringify(claims) : '',
      ],
    );
    if (!Array.isArray(reply)) throw malformed();

    const [status, sessionReply, expiresAt] = reply as unknown[];
    switch (status) {
      case 'unknown_token':
      case 'token_expired':
        return { status };
      case 'session_expired':
      case 'session_revoked':
      case 'reuse_detected':
        return { status, session: this.requireSession(sessionReply) };
      case 'rotated': {
        const session = this.requireSession(sessionReply);
        return {
          status,
          session,
          refreshToken: {
            hash: newHash,
            sessionId: session.id,
            issuedAt: now,
            expiresAt: parseTimestamp(expiresAt),
            consumedAt: null,
          },
        };
      }
      default:
        throw malformed();
    }
  }

  async revoke(sessionId: string, now: number): Promise<Session | null> {
    return parseSession(
      await this.client.eval(
        REVOKE_SESSION,
        [this.sessionKey(sessionId)],
        [String(now)],
      ),
    );
  }

  async revokeAllForSubject(subject: string, now: number): Promise<Session[]> {
    return this.activeForSubject(subject, now, true);
  }

  async listForSubject(subject: string, now: number): Promise<Session[]> {
    return this.activeForSubject(subject, now, false);
  }

  private async activeForSubject(
    subject: string,
    now: number,
    revoke: boolean,
  ): Promise<Session[]> {
    return parseSessionList(
      await this.client.eval(
        ACTIVE_FOR_SUBJECT,
        [this.subjectKey(subject)],
        [this.prefix, String(now), revoke ? '1' : '0'],
      ),
    );
  }

  private requireSession(reply: unknown): Session {
    const session = parseSession(reply);
    if (!session) throw malformed();
    return session;
  }

  private sessionKey(sessionId: string): string {
    return `${this.prefix}s:${sessionId}`;
  }

  private tokenKey(hash: string): string {
    return `${this.prefix}t:${hash}`;
  }

  private subjectKey(subject: string): string {
    return `${this.prefix}u:${subject}`;
  }
}
