import type {
  NewSession,
  RotateInput,
  RotateResult,
  SessionStore,
} from '#src/contracts.js';
import { ToklynError } from '#src/errors.js';
import type { RefreshTokenRecord, Session } from '#src/types.js';

/** In-process store for development and tests. State is lost on restart and is not shared across instances. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, RefreshTokenRecord>();
  private readonly sessionIdsBySubject = new Map<string, Set<string>>();
  private readonly tokenHashesBySession = new Map<string, Set<string>>();

  async create({ session, refreshToken }: NewSession): Promise<void> {
    if (this.sessions.has(session.id) || this.tokens.has(refreshToken.hash)) {
      throw new ToklynError('storage_error', 'Session or token already exists');
    }
    this.sessions.set(session.id, structuredClone(session));
    addTo(this.sessionIdsBySubject, session.subject, session.id);
    this.storeToken(structuredClone(refreshToken));
  }

  async find(sessionId: string): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  // Runs without awaiting, so no other call can interleave.
  async rotate(input: RotateInput): Promise<RotateResult> {
    const { presentedHash, newHash, now, refreshTtlMs, reuseGraceMs, claims } =
      input;
    const presented = this.tokens.get(presentedHash);
    const session = presented && this.sessions.get(presented.sessionId);
    if (!presented || !session) return { status: 'unknown_token' };

    if (session.revokedAt !== null) {
      return { status: 'session_revoked', session: structuredClone(session) };
    }
    if (now >= session.expiresAt) {
      return { status: 'session_expired', session: structuredClone(session) };
    }

    if (presented.consumedAt !== null) {
      const withinGrace =
        reuseGraceMs > 0 && now - presented.consumedAt <= reuseGraceMs;
      if (!withinGrace) {
        session.revokedAt = now;
        return { status: 'reuse_detected', session: structuredClone(session) };
      }
    }

    if (now >= presented.expiresAt) return { status: 'token_expired' };

    presented.consumedAt ??= now;
    if (claims) session.claims = structuredClone(claims);
    const successor: RefreshTokenRecord = {
      hash: newHash,
      sessionId: session.id,
      issuedAt: now,
      expiresAt: Math.min(now + refreshTtlMs, session.expiresAt),
      consumedAt: null,
    };
    this.storeToken(successor);

    return {
      status: 'rotated',
      session: structuredClone(session),
      refreshToken: structuredClone(successor),
    };
  }

  async revoke(sessionId: string, now: number): Promise<Session | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.revokedAt ??= now;
    return structuredClone(session);
  }

  async revokeAllForSubject(subject: string, now: number): Promise<Session[]> {
    const revoked: Session[] = [];
    for (const session of this.activeSessions(subject, now)) {
      session.revokedAt = now;
      revoked.push(structuredClone(session));
    }
    return revoked;
  }

  async listForSubject(subject: string, now: number): Promise<Session[]> {
    return this.activeSessions(subject, now).map((s) => structuredClone(s));
  }

  async purgeExpired(now: number): Promise<number> {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt > now) continue;
      this.sessions.delete(id);
      removeFrom(this.sessionIdsBySubject, session.subject, id);
      for (const hash of this.tokenHashesBySession.get(id) ?? []) {
        this.tokens.delete(hash);
      }
      this.tokenHashesBySession.delete(id);
      removed += 1;
    }
    return removed;
  }

  private storeToken(token: RefreshTokenRecord): void {
    this.tokens.set(token.hash, token);
    addTo(this.tokenHashesBySession, token.sessionId, token.hash);
  }

  private activeSessions(subject: string, now: number): Session[] {
    const active: Session[] = [];
    for (const id of this.sessionIdsBySubject.get(subject) ?? []) {
      const session = this.sessions.get(id);
      if (session && isActive(session, now)) active.push(session);
    }
    return active;
  }
}

function addTo(index: Map<string, Set<string>>, key: string, value: string) {
  const set = index.get(key);
  if (set) set.add(value);
  else index.set(key, new Set([value]));
}

function removeFrom(
  index: Map<string, Set<string>>,
  key: string,
  value: string,
) {
  const set = index.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) index.delete(key);
}

function isActive(session: Session, now: number): boolean {
  return session.revokedAt === null && session.expiresAt > now;
}
