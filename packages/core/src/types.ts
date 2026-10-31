/** All timestamps are epoch milliseconds unless a field name says otherwise. */

export const RESERVED_CLAIMS = [
  'iss',
  'aud',
  'sub',
  'sid',
  'jti',
  'iat',
  'exp',
  'nbf',
  'kid',
] as const;

export type ReservedClaim = (typeof RESERVED_CLAIMS)[number];

/**
 * Constraint for application claims. `object` rather than an index signature, so
 * interfaces are accepted too. Reserved claim names are rejected here and at runtime.
 */
export type ClaimsShape = object & {
  [K in ReservedClaim]?: never;
};

/** Default application claims when no type is given. */
export type CustomClaims = { [key: string]: unknown } & ClaimsShape;

/** Claims the library always sets. `iat` and `exp` are epoch seconds, per the JWT spec. */
export interface StandardClaims {
  sub: string;
  /** Session id. */
  sid: string;
  /** Unique token id, used for the optional access-token denylist. */
  jti: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string | string[];
}

export type AccessTokenClaims<TClaims extends ClaimsShape = CustomClaims> =
  Omit<TClaims, ReservedClaim> & StandardClaims;

/** Free-form string metadata such as `userAgent` or `ip`. */
export type SessionMetadata = Readonly<Record<string, string>>;

export interface Session<TClaims extends ClaimsShape = CustomClaims> {
  id: string;
  subject: string;
  claims: TClaims;
  metadata: SessionMetadata;
  createdAt: number;
  /** Absolute lifetime. Rotation never extends it. */
  expiresAt: number;
  revokedAt: number | null;
}

/** Only a hash of the refresh token is ever stored. */
export interface RefreshTokenRecord {
  hash: string;
  sessionId: string;
  issuedAt: number;
  /** Never later than the session's `expiresAt`. */
  expiresAt: number;
  /** Set when rotated. Consumed records are kept until the session expires, to detect reuse. */
  consumedAt: number | null;
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  sessionId: string;
}

export type AuthEvent =
  | { type: 'session_created'; sessionId: string; subject: string }
  | { type: 'token_refreshed'; sessionId: string; subject: string }
  | { type: 'refresh_reuse_detected'; sessionId: string; subject: string }
  | { type: 'session_revoked'; sessionId: string; subject: string };
