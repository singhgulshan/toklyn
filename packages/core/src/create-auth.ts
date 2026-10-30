import type {
  Auth,
  AuthConfig,
  CreateSessionInput,
  RefreshInput,
} from '#src/auth.js';
import { systemClock } from '#src/clock.js';
import type { Clock, RefreshTokenCodec } from '#src/contracts.js';
import { DefaultRefreshTokenCodec } from '#src/crypto/refresh-token-codec.js';
import { ToklynError } from '#src/errors.js';
import { RESERVED_CLAIMS } from '#src/types.js';
import type {
  AccessTokenClaims,
  AuthEvent,
  CustomClaims,
  RefreshTokenRecord,
  Session,
  TokenPair,
} from '#src/types.js';

const SECOND = 1000;
const VERIFICATION_MODES = new Set<string>(['offline', 'online']);
const RESERVED = new Set<string>(RESERVED_CLAIMS);
/** Our tokens are 43 characters; this only bounds the hashing work an attacker can force. */
const MAX_REFRESH_TOKEN_LENGTH = 1024;

export function createAuth<TClaims extends CustomClaims = CustomClaims>(
  config: AuthConfig,
): Auth<TClaims> {
  return new AuthManager<TClaims>(config);
}

class AuthManager<TClaims extends CustomClaims> implements Auth<TClaims> {
  private readonly clock: Clock;
  private readonly codec: RefreshTokenCodec;
  private readonly online: boolean;
  private readonly reuseGraceMs: number;

  constructor(private readonly config: AuthConfig) {
    assertPositive(config.accessTokenTtlSeconds, 'accessTokenTtlSeconds');
    assertPositive(config.refreshTokenTtlSeconds, 'refreshTokenTtlSeconds');
    assertPositive(config.sessionMaxAgeSeconds, 'sessionMaxAgeSeconds');

    this.reuseGraceMs = config.reuseGraceMs ?? 0;
    if (!Number.isFinite(this.reuseGraceMs) || this.reuseGraceMs < 0) {
      throw invalidConfig('reuseGraceMs must be zero or a positive number');
    }
    const verification = config.verification ?? 'offline';
    if (!VERIFICATION_MODES.has(verification)) {
      throw invalidConfig('verification must be "offline" or "online"');
    }

    this.online = verification === 'online';
    this.clock = config.clock ?? systemClock;
    this.codec = config.refreshTokens ?? new DefaultRefreshTokenCodec();
  }

  async createSession(input: CreateSessionInput<TClaims>): Promise<TokenPair> {
    assertSubject(input.subject);
    const claims = (input.claims ?? {}) as TClaims;
    assertCustomClaims(claims);

    const now = this.clock.now();
    const session: Session<TClaims> = {
      id: crypto.randomUUID(),
      subject: input.subject,
      claims,
      metadata: { ...input.metadata },
      createdAt: now,
      expiresAt: now + this.config.sessionMaxAgeSeconds * SECOND,
      revokedAt: null,
    };
    // Sign before persisting so a signing failure leaves nothing stored.
    const [refresh, access] = await Promise.all([
      this.codec.generate(),
      this.signAccessToken(session, now),
    ]);
    const refreshToken: RefreshTokenRecord = {
      hash: refresh.hash,
      sessionId: session.id,
      issuedAt: now,
      expiresAt: Math.min(
        now + this.config.refreshTokenTtlSeconds * SECOND,
        session.expiresAt,
      ),
      consumedAt: null,
    };
    await guard(() => this.config.sessions.create({ session, refreshToken }));

    this.emit({
      type: 'session_created',
      sessionId: session.id,
      subject: session.subject,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refreshToken.expiresAt,
      sessionId: session.id,
    };
  }

  async refresh(input: RefreshInput<TClaims>): Promise<TokenPair> {
    const presented = input?.refreshToken;
    if (
      typeof presented !== 'string' ||
      presented.length > MAX_REFRESH_TOKEN_LENGTH ||
      presented.trim() === ''
    ) {
      throw new ToklynError(
        'invalid_refresh_token',
        'Refresh token is invalid',
      );
    }
    if (input.claims !== undefined) assertCustomClaims(input.claims);

    const now = this.clock.now();
    const [presentedHash, next] = await Promise.all([
      this.codec.hash(presented),
      this.codec.generate(),
    ]);
    const result = await guard(() =>
      this.config.sessions.rotate({
        presentedHash,
        newHash: next.hash,
        now,
        refreshTtlMs: this.config.refreshTokenTtlSeconds * SECOND,
        reuseGraceMs: this.reuseGraceMs,
        claims: input.claims,
      }),
    );

    switch (result.status) {
      case 'rotated': {
        const access = await this.signAccessToken(result.session, now);
        this.emit({
          type: 'token_refreshed',
          sessionId: result.session.id,
          subject: result.session.subject,
        });
        return {
          accessToken: access.token,
          accessTokenExpiresAt: access.expiresAt,
          refreshToken: next.token,
          refreshTokenExpiresAt: result.refreshToken.expiresAt,
          sessionId: result.session.id,
        };
      }
      case 'unknown_token':
        throw new ToklynError(
          'invalid_refresh_token',
          'Refresh token is invalid',
        );
      case 'token_expired':
        throw new ToklynError('refresh_token_expired', 'Refresh token expired');
      case 'session_expired':
        throw new ToklynError('session_expired', 'Session expired');
      case 'session_revoked':
        throw new ToklynError('session_revoked', 'Session was revoked');
      case 'reuse_detected': {
        const { id: sessionId, subject } = result.session;
        this.emit({ type: 'refresh_reuse_detected', sessionId, subject });
        this.emit({ type: 'session_revoked', sessionId, subject });
        throw new ToklynError(
          'refresh_token_reused',
          'Refresh token was already used; the session was revoked',
        );
      }
    }
  }

  async verifyAccessToken(
    accessToken: string,
  ): Promise<AccessTokenClaims<TClaims>> {
    const now = this.clock.now();
    const claims = await this.config.verifier.verify(accessToken, now);
    if (this.online) await this.assertSessionStillValid(claims, now);
    return claims as AccessTokenClaims<TClaims>;
  }

  async revokeSession(sessionId: string): Promise<void> {
    const now = this.clock.now();
    const session = await guard(() =>
      this.config.sessions.revoke(sessionId, now),
    );
    // A session that was already revoked keeps its earlier timestamp.
    if (session?.revokedAt === now) {
      this.emit({
        type: 'session_revoked',
        sessionId: session.id,
        subject: session.subject,
      });
    }
  }

  async revokeAllSessions(subject: string): Promise<void> {
    const now = this.clock.now();
    const revoked = await guard(() =>
      this.config.sessions.revokeAllForSubject(subject, now),
    );
    for (const session of revoked) {
      this.emit({
        type: 'session_revoked',
        sessionId: session.id,
        subject: session.subject,
      });
    }
  }

  async listSessions(subject: string): Promise<Session<TClaims>[]> {
    const now = this.clock.now();
    const sessions = await guard(() =>
      this.config.sessions.listForSubject(subject, now),
    );
    return sessions as Session<TClaims>[];
  }

  async revokeAccessToken(accessToken: string): Promise<void> {
    const { revocations } = this.config;
    if (!revocations) {
      throw invalidConfig('revokeAccessToken needs a revocations store');
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.config.verifier.verify(accessToken, this.clock.now());
    } catch (error) {
      // An expired token can no longer be used, so there is nothing to revoke.
      if (
        error instanceof ToklynError &&
        error.code === 'access_token_expired'
      ) {
        return;
      }
      throw error;
    }
    await guard(() => revocations.revoke(claims.jti, claims.exp * SECOND));
  }

  private async signAccessToken(
    session: Session,
    now: number,
  ): Promise<{ token: string; expiresAt: number }> {
    const iat = Math.floor(now / SECOND);
    // An access token never outlives its session.
    const exp = Math.min(
      iat + this.config.accessTokenTtlSeconds,
      Math.floor(session.expiresAt / SECOND),
    );
    const claims = {
      ...session.claims,
      sub: session.subject,
      sid: session.id,
      jti: crypto.randomUUID(),
      iat,
      exp,
    } as AccessTokenClaims;

    return {
      token: await this.config.signer.sign(claims),
      expiresAt: exp * SECOND,
    };
  }

  private async assertSessionStillValid(
    claims: AccessTokenClaims,
    now: number,
  ): Promise<void> {
    const session = await guard(() => this.config.sessions.find(claims.sid));
    if (!session) {
      throw new ToklynError('session_not_found', 'Session does not exist');
    }
    if (session.revokedAt !== null) {
      throw new ToklynError('session_revoked', 'Session was revoked');
    }
    if (now >= session.expiresAt) {
      throw new ToklynError('session_expired', 'Session expired');
    }

    const { revocations } = this.config;
    if (revocations && (await guard(() => revocations.isRevoked(claims.jti)))) {
      throw new ToklynError('access_token_revoked', 'Access token was revoked');
    }
  }

  /** A failing listener must never break authentication. */
  private emit(event: AuthEvent): void {
    try {
      this.config.onEvent?.(event);
    } catch {
      // Ignored on purpose.
    }
  }
}

/** Storage and other infrastructure failures surface as `storage_error`. */
async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof ToklynError) throw cause;
    throw new ToklynError('storage_error', 'Storage operation failed', {
      cause,
    });
  }
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw invalidConfig(`${name} must be a positive number`);
  }
}

function assertSubject(subject: unknown): asserts subject is string {
  if (typeof subject !== 'string' || subject.trim() === '') {
    throw new ToklynError(
      'invalid_input',
      'subject must be a non-empty string',
    );
  }
}

function assertCustomClaims(claims: unknown): void {
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
    throw new ToklynError('invalid_input', 'claims must be a plain object');
  }
  const reserved = Object.keys(claims).find((name) => RESERVED.has(name));
  if (reserved) {
    throw new ToklynError(
      'invalid_input',
      `"${reserved}" is a reserved claim name`,
    );
  }
}
