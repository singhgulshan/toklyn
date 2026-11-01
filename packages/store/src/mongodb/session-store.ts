import { ToklynError } from 'toklyn';
import type {
  NewSession,
  RotateInput,
  RotateResult,
  Session,
  SessionStore,
} from 'toklyn';
import type { MongoCollection, MongoDatabase } from '#src/mongodb/client.js';
import {
  SESSION_FIELDS,
  checkString,
  integer,
  malformed,
  parseSession,
  text,
} from '#src/mongodb/codec.js';
import { resolveCollections } from '#src/mongodb/schema.js';
import type { MongoSchemaOptions } from '#src/mongodb/schema.js';

export interface MongoSessionStoreOptions extends MongoSchemaOptions {
  db: MongoDatabase;
}

// Every lost compare-and-swap means another rotation of the session succeeded.
const MAX_ATTEMPTS = 100;

/**
 * Session store backed by MongoDB 6.0+. Each session is one document holding its refresh-token
 * hashes, and every change is a compare-and-swap on the document's version, so rotation is
 * atomic without transactions (works on a standalone server). Create the indexes first with
 * `migrate`. Claims must be JSON-serializable.
 */
export class MongoSessionStore implements SessionStore {
  private readonly sessions: MongoCollection;

  constructor({ db, ...names }: MongoSessionStoreOptions) {
    this.sessions = resolveCollections(db, names).sessions;
  }

  async create({ session, refreshToken }: NewSession): Promise<void> {
    checkString('session id', session.id);
    checkString('subject', session.subject);
    checkString('refresh token hash', refreshToken.hash);
    await this.sessions.insertOne({
      _id: session.id,
      subject: session.subject,
      claims: JSON.stringify(session.claims),
      metadata: JSON.stringify(session.metadata),
      createdAt: session.createdAt,
      lastRefreshedAt: session.lastRefreshedAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      expireAt: new Date(session.expiresAt),
      version: 0,
      tokens: [
        {
          hash: refreshToken.hash,
          issuedAt: refreshToken.issuedAt,
          expiresAt: refreshToken.expiresAt,
        },
      ],
      consumed:
        refreshToken.consumedAt === null
          ? []
          : [{ hash: refreshToken.hash, at: refreshToken.consumedAt }],
    });
  }

  async find(sessionId: string): Promise<Session | null> {
    checkString('session id', sessionId);
    const document = await this.sessions.findOne(
      { _id: sessionId },
      { projection: SESSION_FIELDS },
    );
    return document ? parseSession(document) : null;
  }

  async rotate(input: RotateInput): Promise<RotateResult> {
    const { presentedHash, newHash, now, refreshTtlMs, reuseGraceMs, claims } =
      input;
    checkString('refresh token hash', presentedHash);
    checkString('refresh token hash', newHash);
    const claimsJson = claims ? JSON.stringify(claims) : null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const document = await this.sessions.findOne(
        { 'tokens.hash': presentedHash },
        {
          projection: {
            ...SESSION_FIELDS,
            tokens: { $elemMatch: { hash: presentedHash } },
            consumed: { $elemMatch: { hash: presentedHash } },
          },
        },
      );
      if (!document) return { status: 'unknown_token' };
      const session = parseSession(document);
      const version = integer(document['version']);
      const tokenExpiresAt = integer(only(document['tokens'])['expiresAt']);
      const consumed = document['consumed'];
      const consumedAt =
        consumed === undefined ? null : integer(only(consumed)['at']);
      const unchanged = { _id: session.id, version };

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
        const { matchedCount } = await this.sessions.updateOne(unchanged, {
          $set: { revokedAt: now },
          $inc: { version: 1 },
        });
        if (matchedCount === 0) continue;
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
      const { matchedCount } = await this.sessions.updateOne(unchanged, {
        $set: {
          lastRefreshedAt: now,
          ...(claimsJson === null ? {} : { claims: claimsJson }),
        },
        $push: {
          tokens: {
            hash: successor.hash,
            issuedAt: successor.issuedAt,
            expiresAt: successor.expiresAt,
          },
          // A replay inside the grace window keeps the first consumption time.
          ...(consumedAt === null
            ? { consumed: { hash: presentedHash, at: now } }
            : {}),
        },
        $inc: { version: 1 },
      });
      if (matchedCount === 0) continue;
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
    }
    throw new ToklynError(
      'storage_error',
      'Too many concurrent changes to the session',
    );
  }

  async revoke(sessionId: string, now: number): Promise<Session | null> {
    checkString('session id', sessionId);
    const revoked = await this.sessions.findOneAndUpdate(
      { _id: sessionId, revokedAt: null },
      { $set: { revokedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', projection: SESSION_FIELDS },
    );
    if (revoked) return parseSession(revoked);
    // Already revoked (keeps the first time) or unknown.
    return this.find(sessionId);
  }

  async revokeAllForSubject(subject: string, now: number): Promise<Session[]> {
    checkString('subject', subject);
    const active = { subject, revokedAt: null, expiresAt: { $gt: now } };
    const candidates = await this.sessions
      .find(active, { projection: { _id: 1 } })
      .toArray();
    const revoked: Session[] = [];
    for (const candidate of candidates) {
      const document = await this.sessions.findOneAndUpdate(
        { ...active, _id: text(candidate['_id']) },
        { $set: { revokedAt: now }, $inc: { version: 1 } },
        { returnDocument: 'after', projection: SESSION_FIELDS },
      );
      if (document) revoked.push(parseSession(document));
    }
    return revoked.sort(
      (a, b) => a.createdAt - b.createdAt || compare(a.id, b.id),
    );
  }

  async listForSubject(subject: string, now: number): Promise<Session[]> {
    checkString('subject', subject);
    const documents = await this.sessions
      .find(
        { subject, revokedAt: null, expiresAt: { $gt: now } },
        { projection: SESSION_FIELDS, sort: { createdAt: 1, _id: 1 } },
      )
      .toArray();
    return documents.map(parseSession);
  }

  /** Deletes expired sessions with their refresh tokens. MongoDB's TTL index also does this, within about a minute. */
  async purgeExpired(now: number): Promise<number> {
    const { deletedCount } = await this.sessions.deleteMany({
      expiresAt: { $lte: now },
    });
    return deletedCount;
  }
}

function only(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) throw malformed();
  const [item] = value as unknown[];
  if (typeof item !== 'object' || item === null) throw malformed();
  return item as Record<string, unknown>;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
