import type {
  AccessTokenClaims,
  CustomClaims,
  RefreshTokenRecord,
  Session,
} from './types.js';

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/** Builds and signs a JWT from claims the manager has already assembled. */
export interface AccessTokenSigner {
  sign(claims: AccessTokenClaims): Promise<string>;
}

/**
 * Verifies signature, algorithm, issuer, audience and expiry.
 * Throws `ToklynError` with `invalid_access_token` or `access_token_expired`.
 */
export interface AccessTokenVerifier {
  verify(token: string, now: number): Promise<AccessTokenClaims>;
}

/** Generates opaque refresh tokens and hashes them for storage. */
export interface RefreshTokenCodec {
  generate(): Promise<{ token: string; hash: string }>;
  hash(token: string): Promise<string>;
}

export interface NewSession {
  session: Session;
  refreshToken: RefreshTokenRecord;
}

export interface RotateInput {
  presentedHash: string;
  newHash: string;
  now: number;
  refreshTtlMs: number;
  /** 0 means strict: any reuse of a consumed token revokes the session. */
  reuseGraceMs: number;
  /** Replaces `session.claims` when the rotation succeeds, and only then. */
  claims?: CustomClaims;
}

export type RotateResult =
  | { status: 'rotated'; session: Session; refreshToken: RefreshTokenRecord }
  /** Hash was never issued. The session is left untouched. */
  | { status: 'unknown_token' }
  | { status: 'token_expired' }
  | { status: 'session_expired'; session: Session }
  | { status: 'session_revoked'; session: Session }
  /** The store has already revoked the session by the time this is returned. */
  | { status: 'reuse_detected'; session: Session };

/**
 * Session and refresh-token persistence.
 *
 * `rotate` must be atomic: validating the presented token, consuming it, inserting its
 * successor and (on reuse) revoking the session happen as one operation, so concurrent
 * calls with the same token can never both succeed outside the grace window.
 * Within the grace window a consumed token is accepted again and yields a fresh successor.
 * The new token's expiry is `min(now + refreshTtlMs, session.expiresAt)`.
 */
export interface SessionStore {
  /** Stores the session and its first token together. Rejects if either already exists. */
  create(input: NewSession): Promise<void>;
  find(sessionId: string): Promise<Session | null>;
  rotate(input: RotateInput): Promise<RotateResult>;
  /** Idempotent. Returns the session if it existed. */
  revoke(sessionId: string, now: number): Promise<Session | null>;
  /** Revokes active sessions only, and returns just those. */
  revokeAllForSubject(subject: string, now: number): Promise<Session[]>;
  /** Active sessions only: not revoked, not expired. */
  listForSubject(subject: string, now: number): Promise<Session[]>;
  /** Optional cleanup of expired sessions and their token records. */
  purgeExpired?(now: number): Promise<number>;
}

/** Optional denylist for individual access tokens, used only in `online` verification. */
export interface AccessTokenRevocationStore {
  /** The entry may be dropped after `expiresAt`. */
  revoke(jti: string, expiresAt: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

export type { CustomClaims };
