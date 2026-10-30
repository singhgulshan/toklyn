import { beforeEach, describe, expect, it } from 'vitest';
import {
  DefaultRefreshTokenCodec,
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemoryAccessTokenRevocationStore,
  MemorySessionStore,
  ToklynError,
  createAuth,
} from '#src/index.js';
import type {
  AuthConfig,
  AuthEvent,
  NewSession,
  RotateInput,
  RotateResult,
  Session,
} from '#src/index.js';

const T0 = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const ACCESS_TTL = 900;
const REFRESH_TTL = 7 * 86_400;
const SESSION_MAX_AGE = 30 * 86_400;

const keyConfig = {
  keys: [{ algorithm: 'HS256' as const, secret: new Uint8Array(32).fill(9) }],
};

class FakeClock {
  constructor(public time = T0) {}
  now = () => this.time;
  advance(ms: number) {
    this.time += ms;
  }
}

class RecordingStore extends MemorySessionStore {
  created: NewSession[] = [];
  override async create(input: NewSession) {
    this.created.push(structuredClone(input));
    return super.create(input);
  }
}

class FailingCreateStore extends MemorySessionStore {
  override async create(): Promise<void> {
    throw new Error('db down');
  }
}

class FlakyRotateStore extends MemorySessionStore {
  failNext = true;
  override async rotate(input: RotateInput): Promise<RotateResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('db down');
    }
    return super.rotate(input);
  }
}

class FailingFindStore extends MemorySessionStore {
  override async find(): Promise<Session | null> {
    throw new Error('db down');
  }
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

function setup(
  overrides: Partial<AuthConfig> = {},
  store: MemorySessionStore = new MemorySessionStore(),
) {
  const clock = new FakeClock();
  const events: AuthEvent[] = [];
  const revocations = new MemoryAccessTokenRevocationStore(clock);
  const auth = createAuth<{ role?: string }>({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions: store,
    revocations,
    clock,
    accessTokenTtlSeconds: ACCESS_TTL,
    refreshTokenTtlSeconds: REFRESH_TTL,
    sessionMaxAgeSeconds: SESSION_MAX_AGE,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { auth, clock, events, store, revocations };
}

describe('createAuth', () => {
  describe('createSession', () => {
    it('returns an access token, an opaque refresh token and the expiry times', async () => {
      const { auth } = setup();

      const pair = await auth.createSession({
        subject: 'user-1',
        claims: { role: 'admin' },
      });

      expect(pair.sessionId).toBeTruthy();
      expect(pair.accessTokenExpiresAt).toBe(T0 + ACCESS_TTL * SECOND);
      expect(pair.refreshTokenExpiresAt).toBe(T0 + REFRESH_TTL * SECOND);
      expect(pair.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(pair.accessToken.split('.')).toHaveLength(3);
    });

    it('issues an access token carrying the subject, session id and claims', async () => {
      const { auth } = setup();

      const pair = await auth.createSession({
        subject: 'user-1',
        claims: { role: 'admin' },
      });
      const claims = await auth.verifyAccessToken(pair.accessToken);

      expect(claims).toMatchObject({
        sub: 'user-1',
        sid: pair.sessionId,
        role: 'admin',
        iat: T0 / SECOND,
        exp: T0 / SECOND + ACCESS_TTL,
      });
      expect(claims.jti).toBeTruthy();
    });

    it('stores only a hash of the refresh token', async () => {
      const store = new RecordingStore();
      const { auth } = setup({}, store);

      const pair = await auth.createSession({ subject: 'user-1' });
      const [created] = store.created;

      expect(created?.refreshToken.hash).toBe(
        await new DefaultRefreshTokenCodec().hash(pair.refreshToken),
      );
      expect(JSON.stringify(created)).not.toContain(pair.refreshToken);
    });

    it('keeps the metadata with the session', async () => {
      const { auth } = setup();

      await auth.createSession({
        subject: 'user-1',
        metadata: { userAgent: 'curl' },
      });

      const [session] = await auth.listSessions('user-1');
      expect(session?.metadata).toEqual({ userAgent: 'curl' });
    });

    it('caps token lifetimes at the absolute session lifetime', async () => {
      const { auth } = setup({
        sessionMaxAgeSeconds: 300,
        accessTokenTtlSeconds: 900,
      });

      const pair = await auth.createSession({ subject: 'user-1' });

      expect(pair.refreshTokenExpiresAt).toBe(T0 + 300 * SECOND);
      expect(pair.accessTokenExpiresAt).toBe(T0 + 300 * SECOND);
    });

    it('rejects reserved claim names', async () => {
      const { auth } = setup();

      for (const name of ['sub', 'sid', 'jti', 'exp', 'iat', 'iss', 'kid']) {
        const claims = { [name]: 'x' } as never;
        expect(await codeOf(auth.createSession({ subject: 'u', claims }))).toBe(
          'invalid_input',
        );
      }
    });

    it('rejects an empty subject', async () => {
      const { auth } = setup();

      expect(await codeOf(auth.createSession({ subject: '' }))).toBe(
        'invalid_input',
      );
    });

    it('announces the new session', async () => {
      const { auth, events } = setup();

      const pair = await auth.createSession({ subject: 'user-1' });

      expect(events).toEqual([
        {
          type: 'session_created',
          sessionId: pair.sessionId,
          subject: 'user-1',
        },
      ]);
    });

    it('returns no credentials when storage fails', async () => {
      const { auth } = setup({}, new FailingCreateStore());

      expect(await codeOf(auth.createSession({ subject: 'user-1' }))).toBe(
        'storage_error',
      );
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token and keeps the same session', async () => {
      const { auth, clock } = setup();
      const first = await auth.createSession({ subject: 'user-1' });
      clock.advance(MINUTE);

      const second = await auth.refresh({ refreshToken: first.refreshToken });

      expect(second.sessionId).toBe(first.sessionId);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.accessToken).not.toBe(first.accessToken);
      expect(second.accessTokenExpiresAt).toBe(
        T0 + MINUTE + ACCESS_TTL * SECOND,
      );
      expect(await auth.verifyAccessToken(second.accessToken)).toMatchObject({
        sub: 'user-1',
        sid: first.sessionId,
      });
    });

    it('can be chained', async () => {
      const { auth, clock } = setup();
      let pair = await auth.createSession({ subject: 'user-1' });

      for (let i = 0; i < 5; i += 1) {
        clock.advance(MINUTE);
        pair = await auth.refresh({ refreshToken: pair.refreshToken });
      }

      expect(await auth.verifyAccessToken(pair.accessToken)).toMatchObject({
        sub: 'user-1',
      });
    });

    it('keeps the stored claims when none are supplied', async () => {
      const { auth } = setup();
      const first = await auth.createSession({
        subject: 'user-1',
        claims: { role: 'admin' },
      });

      const second = await auth.refresh({ refreshToken: first.refreshToken });

      expect(await auth.verifyAccessToken(second.accessToken)).toMatchObject({
        role: 'admin',
      });
    });

    it('replaces the claims when new ones are supplied', async () => {
      const { auth } = setup();
      const first = await auth.createSession({
        subject: 'user-1',
        claims: { role: 'admin' },
      });

      const second = await auth.refresh({
        refreshToken: first.refreshToken,
        claims: { role: 'viewer' },
      });

      expect(await auth.verifyAccessToken(second.accessToken)).toMatchObject({
        role: 'viewer',
      });
      const [session] = await auth.listSessions('user-1');
      expect(session?.claims).toEqual({ role: 'viewer' });
    });

    it('rejects reserved claim names in new claims', async () => {
      const { auth } = setup();
      const first = await auth.createSession({ subject: 'user-1' });

      expect(
        await codeOf(
          auth.refresh({
            refreshToken: first.refreshToken,
            claims: { sub: 'admin' } as never,
          }),
        ),
      ).toBe('invalid_input');
    });

    it('never extends the absolute session lifetime', async () => {
      const { auth, clock } = setup({
        sessionMaxAgeSeconds: 10 * 60,
        refreshTokenTtlSeconds: 8 * 60,
      });
      let pair = await auth.createSession({ subject: 'user-1' });

      clock.advance(5 * MINUTE);
      pair = await auth.refresh({ refreshToken: pair.refreshToken });

      expect(pair.refreshTokenExpiresAt).toBe(T0 + 10 * MINUTE);
      expect(pair.accessTokenExpiresAt).toBe(T0 + 10 * MINUTE);
    });

    it.each(['', 'not-a-real-token', '   '])(
      'rejects the unknown refresh token %j',
      async (refreshToken) => {
        const { auth } = setup();

        expect(await codeOf(auth.refresh({ refreshToken }))).toBe(
          'invalid_refresh_token',
        );
      },
    );

    it('rejects a non-string refresh token', async () => {
      const { auth } = setup();

      expect(
        await codeOf(auth.refresh({ refreshToken: undefined as never })),
      ).toBe('invalid_refresh_token');
    });

    it('rejects an oversized refresh token without hashing it', async () => {
      const codec = new DefaultRefreshTokenCodec();
      const hashed: string[] = [];
      const { auth } = setup({
        refreshTokens: {
          generate: () => codec.generate(),
          hash: (token) => {
            hashed.push(token);
            return codec.hash(token);
          },
        },
      });

      expect(
        await codeOf(auth.refresh({ refreshToken: 'a'.repeat(5000) })),
      ).toBe('invalid_refresh_token');
      expect(hashed).toEqual([]);
    });

    it('rejects an expired refresh token', async () => {
      const { auth, clock } = setup({ refreshTokenTtlSeconds: 60 });
      const pair = await auth.createSession({ subject: 'user-1' });
      clock.advance(2 * MINUTE);

      expect(
        await codeOf(auth.refresh({ refreshToken: pair.refreshToken })),
      ).toBe('refresh_token_expired');
    });

    it('rejects a token once the session has expired', async () => {
      const { auth, clock } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });
      clock.advance(SESSION_MAX_AGE * SECOND + DAY);

      expect(
        await codeOf(auth.refresh({ refreshToken: pair.refreshToken })),
      ).toBe('session_expired');
    });

    it('rejects a token of a revoked session', async () => {
      const { auth } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });
      await auth.revokeSession(pair.sessionId);

      expect(
        await codeOf(auth.refresh({ refreshToken: pair.refreshToken })),
      ).toBe('session_revoked');
    });

    it('announces each refresh', async () => {
      const { auth, events } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });

      await auth.refresh({ refreshToken: pair.refreshToken });

      expect(events.at(-1)).toEqual({
        type: 'token_refreshed',
        sessionId: pair.sessionId,
        subject: 'user-1',
      });
    });

    it('returns no credentials and consumes nothing when storage fails', async () => {
      const store = new FlakyRotateStore();
      const { auth } = setup({}, store);
      const pair = await auth.createSession({ subject: 'user-1' });

      expect(
        await codeOf(auth.refresh({ refreshToken: pair.refreshToken })),
      ).toBe('storage_error');
      const retry = await auth.refresh({ refreshToken: pair.refreshToken });
      expect(retry.sessionId).toBe(pair.sessionId);
    });
  });

  describe('reuse detection', () => {
    it('revokes the session when a used refresh token comes back', async () => {
      const { auth, events } = setup();
      const first = await auth.createSession({ subject: 'user-1' });
      const second = await auth.refresh({ refreshToken: first.refreshToken });

      expect(
        await codeOf(auth.refresh({ refreshToken: first.refreshToken })),
      ).toBe('refresh_token_reused');
      expect(
        await codeOf(auth.refresh({ refreshToken: second.refreshToken })),
      ).toBe('session_revoked');
      expect(events).toContainEqual({
        type: 'refresh_reuse_detected',
        sessionId: first.sessionId,
        subject: 'user-1',
      });
    });

    it('lets only one of two concurrent refreshes win', async () => {
      const { auth } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });

      const results = await Promise.allSettled([
        auth.refresh({ refreshToken: pair.refreshToken }),
        auth.refresh({ refreshToken: pair.refreshToken }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const rejected = results.find((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        code: 'refresh_token_reused',
      });
    });

    it('accepts a repeat inside the grace window with a fresh token', async () => {
      const { auth, clock } = setup({ reuseGraceMs: 10 * SECOND });
      const first = await auth.createSession({ subject: 'user-1' });
      const a = await auth.refresh({ refreshToken: first.refreshToken });
      clock.advance(5 * SECOND);

      const b = await auth.refresh({ refreshToken: first.refreshToken });

      expect(b.refreshToken).not.toBe(a.refreshToken);
      expect(await auth.verifyAccessToken(b.accessToken)).toMatchObject({
        sid: first.sessionId,
      });
    });

    it('lets two concurrent refreshes both win inside the grace window', async () => {
      const { auth } = setup({ reuseGraceMs: 10 * SECOND });
      const pair = await auth.createSession({ subject: 'user-1' });

      const [a, b] = await Promise.all([
        auth.refresh({ refreshToken: pair.refreshToken }),
        auth.refresh({ refreshToken: pair.refreshToken }),
      ]);

      expect(a.refreshToken).not.toBe(b.refreshToken);
    });

    it('treats a repeat after the grace window as reuse', async () => {
      const { auth, clock } = setup({ reuseGraceMs: 10 * SECOND });
      const first = await auth.createSession({ subject: 'user-1' });
      await auth.refresh({ refreshToken: first.refreshToken });
      clock.advance(11 * SECOND);

      expect(
        await codeOf(auth.refresh({ refreshToken: first.refreshToken })),
      ).toBe('refresh_token_reused');
    });
  });

  describe('verifyAccessToken', () => {
    it('rejects an expired token', async () => {
      const { auth, clock } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });
      clock.advance((ACCESS_TTL + 1) * SECOND);

      expect(await codeOf(auth.verifyAccessToken(pair.accessToken))).toBe(
        'access_token_expired',
      );
    });

    it('rejects a malformed token', async () => {
      const { auth } = setup();

      expect(await codeOf(auth.verifyAccessToken('nope'))).toBe(
        'invalid_access_token',
      );
    });

    it('offline mode keeps accepting a token after its session is revoked', async () => {
      const { auth } = setup({ verification: 'offline' });
      const pair = await auth.createSession({ subject: 'user-1' });

      await auth.revokeSession(pair.sessionId);

      expect(await auth.verifyAccessToken(pair.accessToken)).toMatchObject({
        sid: pair.sessionId,
      });
    });

    describe('online mode', () => {
      it('accepts a token of an active session', async () => {
        const { auth } = setup({ verification: 'online' });
        const pair = await auth.createSession({ subject: 'user-1' });

        expect(await auth.verifyAccessToken(pair.accessToken)).toMatchObject({
          sid: pair.sessionId,
        });
      });

      it('rejects a token once its session is revoked', async () => {
        const { auth } = setup({ verification: 'online' });
        const pair = await auth.createSession({ subject: 'user-1' });
        await auth.revokeSession(pair.sessionId);

        expect(await codeOf(auth.verifyAccessToken(pair.accessToken))).toBe(
          'session_revoked',
        );
      });

      it('rejects a token whose session no longer exists', async () => {
        const pair = await setup().auth.createSession({ subject: 'user-1' });
        const { auth } = setup({ verification: 'online' });

        expect(await codeOf(auth.verifyAccessToken(pair.accessToken))).toBe(
          'session_not_found',
        );
      });

      it('rejects a token that was individually revoked', async () => {
        const { auth } = setup({ verification: 'online' });
        const pair = await auth.createSession({ subject: 'user-1' });
        const other = await auth.createSession({ subject: 'user-1' });

        await auth.revokeAccessToken(pair.accessToken);

        expect(await codeOf(auth.verifyAccessToken(pair.accessToken))).toBe(
          'access_token_revoked',
        );
        expect(await auth.verifyAccessToken(other.accessToken)).toBeTruthy();
      });

      it('fails closed when storage is down', async () => {
        const { auth } = setup(
          { verification: 'online' },
          new FailingFindStore(),
        );
        const offline = setup().auth;
        const pair = await offline.createSession({ subject: 'user-1' });

        expect(await codeOf(auth.verifyAccessToken(pair.accessToken))).toBe(
          'storage_error',
        );
      });
    });
  });

  describe('revocation', () => {
    it('revokeSession is idempotent and ignores unknown sessions', async () => {
      const { auth } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });

      await auth.revokeSession(pair.sessionId);
      await auth.revokeSession(pair.sessionId);
      await auth.revokeSession('missing');

      expect(await auth.listSessions('user-1')).toEqual([]);
    });

    it('announces a revoked session once', async () => {
      const { auth, events } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });

      await auth.revokeSession(pair.sessionId);

      expect(events.filter((e) => e.type === 'session_revoked')).toEqual([
        {
          type: 'session_revoked',
          sessionId: pair.sessionId,
          subject: 'user-1',
        },
      ]);
    });

    it('revokeAllSessions only touches the given subject', async () => {
      const { auth, events } = setup();
      await auth.createSession({ subject: 'alice' });
      await auth.createSession({ subject: 'alice' });
      await auth.createSession({ subject: 'bob' });

      await auth.revokeAllSessions('alice');

      expect(await auth.listSessions('alice')).toEqual([]);
      expect(await auth.listSessions('bob')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'session_revoked')).toHaveLength(
        2,
      );
    });

    it('listSessions returns active sessions with their claims', async () => {
      const { auth } = setup();
      const pair = await auth.createSession({
        subject: 'user-1',
        claims: { role: 'admin' },
      });

      const sessions = await auth.listSessions('user-1');

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: pair.sessionId,
        subject: 'user-1',
        claims: { role: 'admin' },
      });
    });

    it('revokeAccessToken needs a revocation store', async () => {
      const { auth } = setup({ revocations: undefined });
      const pair = await auth.createSession({ subject: 'user-1' });

      expect(await codeOf(auth.revokeAccessToken(pair.accessToken))).toBe(
        'invalid_config',
      );
    });

    it('revokeAccessToken ignores a token that already expired', async () => {
      const { auth, clock } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });
      clock.advance((ACCESS_TTL + 1) * SECOND);

      await expect(
        auth.revokeAccessToken(pair.accessToken),
      ).resolves.toBeUndefined();
    });

    it('revokeAccessToken rejects garbage', async () => {
      const { auth } = setup();

      expect(await codeOf(auth.revokeAccessToken('nope'))).toBe(
        'invalid_access_token',
      );
    });
  });

  describe('events', () => {
    it('keeps working when a listener throws', async () => {
      const { auth } = setup({
        onEvent: () => {
          throw new Error('listener bug');
        },
      });

      const pair = await auth.createSession({ subject: 'user-1' });

      expect(pair.sessionId).toBeTruthy();
    });
  });

  describe('configuration', () => {
    const invalid: [string, Partial<AuthConfig>][] = [
      ['a zero access ttl', { accessTokenTtlSeconds: 0 }],
      ['a negative refresh ttl', { refreshTokenTtlSeconds: -1 }],
      ['a NaN session max age', { sessionMaxAgeSeconds: Number.NaN }],
      ['an infinite access ttl', { accessTokenTtlSeconds: Infinity }],
      ['a negative grace window', { reuseGraceMs: -1 }],
      ['an unknown verification mode', { verification: 'sometimes' as never }],
    ];

    it.each(invalid)('rejects %s', (_label, overrides) => {
      expect(() => setup(overrides)).toThrowError(ToklynError);
      try {
        setup(overrides);
      } catch (error) {
        expect((error as ToklynError).code).toBe('invalid_config');
      }
    });
  });

  describe('defaults', () => {
    let auth: ReturnType<typeof setup>['auth'];

    beforeEach(() => {
      auth = createAuth({
        signer: new JwtAccessTokenSigner(keyConfig),
        verifier: new JwtAccessTokenVerifier(keyConfig),
        sessions: new MemorySessionStore(),
        accessTokenTtlSeconds: ACCESS_TTL,
        refreshTokenTtlSeconds: REFRESH_TTL,
        sessionMaxAgeSeconds: SESSION_MAX_AGE,
      });
    });

    it('works with the system clock and the default codec', async () => {
      const pair = await auth.createSession({ subject: 'user-1' });
      const next = await auth.refresh({ refreshToken: pair.refreshToken });

      expect(await auth.verifyAccessToken(next.accessToken)).toMatchObject({
        sub: 'user-1',
      });
    });
  });
});
