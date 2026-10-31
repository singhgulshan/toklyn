import type {
  AccessTokenRevocationStore,
  AccessTokenSigner,
  AccessTokenVerifier,
  Clock,
  RefreshTokenCodec,
  SessionStore,
} from './contracts.js';
import type {
  AccessTokenClaims,
  AuthEvent,
  ClaimsShape,
  CustomClaims,
  Session,
  SessionMetadata,
  TokenPair,
} from './types.js';

/** `undefined` keeps the claims, an object replaces them, `null` revokes the session. */
export type RefreshDecision<TClaims extends ClaimsShape = CustomClaims> =
  TClaims | null | undefined;

export interface AuthConfig<TClaims extends ClaimsShape = CustomClaims> {
  signer: AccessTokenSigner;
  verifier: AccessTokenVerifier;
  sessions: SessionStore;
  /** Defaults to a Web Crypto implementation. */
  refreshTokens?: RefreshTokenCodec;
  /** Needed by `revokeAccessToken`, and consulted by `online` verification. */
  revocations?: AccessTokenRevocationStore;
  clock?: Clock;

  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Absolute session lifetime, measured from creation. */
  sessionMaxAgeSeconds: number;

  /**
   * `offline`: signature and expiry only, no storage call.
   * `online`: also checks the session and denylist, and fails closed if storage errors.
   * Defaults to `offline`.
   */
  verification?: 'offline' | 'online';
  /** Defaults to 0, which is strict reuse detection. */
  reuseGraceMs?: number;
  /**
   * Runs before each refresh of an active session, e.g. to reload the user. Its claims are
   * stored with the rotation. If it throws, nothing is consumed and the refresh fails with
   * `storage_error`.
   */
  onRefresh?: (
    session: Session<TClaims>,
  ) => RefreshDecision<TClaims> | Promise<RefreshDecision<TClaims>>;
  onEvent?: (event: AuthEvent) => void;
}

export interface CreateSessionInput<
  TClaims extends ClaimsShape = CustomClaims,
> {
  subject: string;
  claims?: TClaims;
  metadata?: SessionMetadata;
}

export interface RefreshInput<TClaims extends ClaimsShape = CustomClaims> {
  refreshToken: string;
  /** Replaces the session's stored claims, e.g. after a role change. */
  claims?: TClaims;
}

export interface Auth<TClaims extends ClaimsShape = CustomClaims> {
  /** The configured `reuseGraceMs`. */
  readonly reuseGraceMs: number;
  createSession(input: CreateSessionInput<TClaims>): Promise<TokenPair>;
  refresh(input: RefreshInput<TClaims>): Promise<TokenPair>;
  /**
   * Revokes the session a refresh token belongs to. Invalid, expired or already revoked
   * tokens are ignored. Does not run `onRefresh`.
   */
  logout(refreshToken: string): Promise<void>;
  verifyAccessToken(accessToken: string): Promise<AccessTokenClaims<TClaims>>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllSessions(subject: string): Promise<void>;
  /** Revokes every active session of the subject except `keepSessionId`, e.g. "sign out other devices". */
  revokeOtherSessions(subject: string, keepSessionId: string): Promise<void>;
  listSessions(subject: string): Promise<Session<TClaims>[]>;
  /** Denylists one access token. Requires `revocations`. */
  revokeAccessToken(accessToken: string): Promise<void>;
}
