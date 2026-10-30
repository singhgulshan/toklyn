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
  CustomClaims,
  Session,
  SessionMetadata,
  TokenPair,
} from './types.js';

export interface AuthConfig {
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
  onEvent?: (event: AuthEvent) => void;
}

export interface CreateSessionInput<
  TClaims extends CustomClaims = CustomClaims,
> {
  subject: string;
  claims?: TClaims;
  metadata?: SessionMetadata;
}

export interface RefreshInput<TClaims extends CustomClaims = CustomClaims> {
  refreshToken: string;
  /** Replaces the session's stored claims, e.g. after a role change. */
  claims?: TClaims;
}

export interface Auth<TClaims extends CustomClaims = CustomClaims> {
  createSession(input: CreateSessionInput<TClaims>): Promise<TokenPair>;
  refresh(input: RefreshInput<TClaims>): Promise<TokenPair>;
  verifyAccessToken(accessToken: string): Promise<AccessTokenClaims<TClaims>>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllSessions(subject: string): Promise<void>;
  listSessions(subject: string): Promise<Session<TClaims>[]>;
  /** Denylists one access token. Requires `revocations`. */
  revokeAccessToken(accessToken: string): Promise<void>;
}
