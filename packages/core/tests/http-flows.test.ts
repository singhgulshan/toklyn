import { describe, expect, it } from 'vitest';
import { createToklynHttp } from '#src/http/index.js';
import type { ToklynHttpRequest, ToklynHttpResponse } from '#src/http/index.js';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  createAuth,
} from '#src/index.js';
import type { AuthConfig, RotateResult, Session } from '#src/index.js';

const T0 = 1_700_000_000_000;
const ORIGIN = 'https://app.example.com';
const COOKIE = '__Host-toklyn_refresh';
const keyConfig = {
  keys: [{ algorithm: 'HS256' as const, secret: new Uint8Array(32).fill(7) }],
};

class FakeClock {
  time = T0;
  now = () => this.time;
}

class FailingStore extends MemorySessionStore {
  failRotate = false;
  failFind = false;
  override async rotate(
    input: Parameters<MemorySessionStore['rotate']>[0],
  ): Promise<RotateResult> {
    if (this.failRotate) throw new Error('db down');
    return super.rotate(input);
  }
  override async find(id: string): Promise<Session | null> {
    if (this.failFind) throw new Error('db down');
    return super.find(id);
  }
}

function setup(overrides: Partial<AuthConfig> = {}) {
  const clock = new FakeClock();
  const store = new FailingStore();
  const auth = createAuth({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions: store,
    clock,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    sessionMaxAgeSeconds: 86_400,
    ...overrides,
  });
  const http = createToklynHttp(auth, { allowedOrigins: [ORIGIN], clock });
  return { auth, http, clock, store };
}

function request(
  headers: Record<string, string> = {},
  method = 'POST',
): ToklynHttpRequest {
  return { method, header: (name) => headers[name] };
}

function browser(refreshToken?: string): ToklynHttpRequest {
  return request({
    origin: ORIGIN,
    ...(refreshToken === undefined
      ? {}
      : { cookie: `${COOKIE}=${refreshToken}` }),
  });
}

function header(response: ToklynHttpResponse, name: string) {
  return response.headers.filter(([key]) => key === name).map(([, v]) => v);
}

function cookieValue(response: ToklynHttpResponse): string {
  const [setCookie] = header(response, 'Set-Cookie');
  return /^[^=]+=([^;]*)/.exec(setCookie ?? '')?.[1] ?? '';
}

const UNAUTHORIZED = { error: 'unauthorized' };
const CLEARED = `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;

describe('createToklynHttp', () => {
  it('validates options up front', () => {
    const { auth } = setup();
    expect(() => createToklynHttp(auth, { allowedOrigins: ['*'] })).toThrow(
      'allowedOrigins',
    );
    expect(() => createToklynHttp(auth, { cookie: { path: 'x' } })).toThrow(
      'cookie path',
    );
  });

  describe('issue', () => {
    it('puts the refresh token only in the cookie', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = http.issue(tokens);

      expect(response.status).toBe(200);
      expect(header(response, 'Set-Cookie')).toEqual([
        `${COOKIE}=${tokens.refreshToken}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Strict`,
      ]);
      expect(header(response, 'Cache-Control')).toEqual(['no-store']);
      expect(response.body).toEqual({
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        sessionId: tokens.sessionId,
      });
      expect(JSON.stringify(response.body)).not.toContain(tokens.refreshToken);
    });
  });

  describe('authenticate', () => {
    it('returns the claims for a valid Bearer token', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const result = await http.authenticate(
        request({ authorization: `Bearer ${tokens.accessToken}` }),
      );

      expect(result.ok && result.claims.sub).toBe('u1');
    });

    it('gives the same 401 for missing, malformed, invalid and expired tokens', async () => {
      const { auth, http, clock } = setup();
      const { accessToken } = await auth.createSession({ subject: 'u1' });
      const expected = {
        ok: false,
        response: {
          status: 401,
          headers: [
            ['WWW-Authenticate', 'Bearer'],
            ['Cache-Control', 'no-store'],
          ],
          body: UNAUTHORIZED,
        },
      };

      const attempts = [
        request(),
        request({ authorization: accessToken }),
        request({ authorization: `Bearer ${accessToken}x` }),
        request({ cookie: `${COOKIE}=${accessToken}` }),
      ];
      for (const attempt of attempts) {
        expect(await http.authenticate(attempt)).toEqual(expected);
      }
      clock.time += 901_000;
      expect(
        await http.authenticate(
          request({ authorization: `Bearer ${accessToken}` }),
        ),
      ).toEqual(expected);
    });

    it('fails closed with 503 when online verification cannot reach storage', async () => {
      const { auth, http, store } = setup({ verification: 'online' });
      const { accessToken } = await auth.createSession({ subject: 'u1' });
      store.failFind = true;

      const result = await http.authenticate(
        request({ authorization: `Bearer ${accessToken}` }),
      );

      expect(result).toEqual({
        ok: false,
        response: {
          status: 503,
          headers: [['Cache-Control', 'no-store']],
          body: { error: 'service_unavailable' },
        },
      });
    });
  });

  describe('authenticateOptional', () => {
    const GUEST = { ok: true, claims: null };

    it('returns the claims for a valid token and null without one', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const signedIn = await http.authenticateOptional(
        request({ authorization: `Bearer ${tokens.accessToken}` }),
      );

      expect(signedIn.ok && signedIn.claims?.sub).toBe('u1');
      expect(await http.authenticateOptional(request())).toEqual(GUEST);
      expect(
        await http.authenticateOptional(request({ authorization: 'Basic x' })),
      ).toEqual(GUEST);
    });

    it('rejects invalid and expired tokens with 401 by default', async () => {
      const { auth, http, clock } = setup();
      const { accessToken } = await auth.createSession({ subject: 'u1' });
      clock.time += 901_000;

      for (const token of ['nope', accessToken]) {
        const result = await http.authenticateOptional(
          request({ authorization: `Bearer ${token}` }),
        );
        expect(!result.ok && result.response.status).toBe(401);
      }
    });

    it('treats invalid and expired tokens as guests with invalidToken "ignore"', async () => {
      const { auth, http, clock } = setup();
      const { accessToken } = await auth.createSession({ subject: 'u1' });
      clock.time += 901_000;

      for (const token of ['nope', accessToken]) {
        expect(
          await http.authenticateOptional(
            request({ authorization: `Bearer ${token}` }),
            { invalidToken: 'ignore' },
          ),
        ).toEqual(GUEST);
      }
    });

    it('still fails closed with 503 when it ignores invalid tokens', async () => {
      const { auth, http, store } = setup({ verification: 'online' });
      const { accessToken } = await auth.createSession({ subject: 'u1' });
      store.failFind = true;

      const result = await http.authenticateOptional(
        request({ authorization: `Bearer ${accessToken}` }),
        { invalidToken: 'ignore' },
      );

      expect(!result.ok && result.response.status).toBe(503);
    });

    it('rejects an unknown invalidToken value', async () => {
      const { http } = setup();
      await expect(
        http.authenticateOptional(request(), {
          invalidToken: 'maybe' as never,
        }),
      ).rejects.toMatchObject({ code: 'invalid_config' });
    });
  });

  describe('refresh', () => {
    it('rotates the cookie and returns a new access token', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = await http.refresh(browser(tokens.refreshToken));

      expect(response.status).toBe(200);
      const rotated = cookieValue(response);
      expect(rotated).not.toBe(tokens.refreshToken);
      expect(rotated?.startsWith(`${tokens.sessionId}.`)).toBe(true);
      expect(response.body).toMatchObject({ sessionId: tokens.sessionId });
    });

    it('accepts same-origin requests without an allow-listed Origin', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = await http.refresh(
        request({
          'sec-fetch-site': 'same-origin',
          cookie: `${COOKIE}=${tokens.refreshToken}`,
        }),
      );

      expect(response.status).toBe(200);
    });

    it('rejects cross-site requests before touching the token', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });
      const cookie = `${COOKIE}=${tokens.refreshToken}`;

      for (const attempt of [
        request({ cookie }),
        request({ cookie, origin: 'https://evil.example' }),
        request({ cookie, 'sec-fetch-site': 'cross-site' }),
      ]) {
        const response = await http.refresh(attempt);
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: 'forbidden' });
        expect(header(response, 'Set-Cookie')).toEqual([]);
      }
      expect((await http.refresh(browser(tokens.refreshToken))).status).toBe(
        200,
      );
    });

    it('clears the cookie with a 401 when it is missing or invalid', async () => {
      const { http } = setup();

      for (const attempt of [browser(), browser('not-a-real-token')]) {
        const response = await http.refresh(attempt);
        expect(response.status).toBe(401);
        expect(response.body).toEqual(UNAUTHORIZED);
        expect(header(response, 'Set-Cookie')).toEqual([CLEARED]);
      }
    });

    it('revokes the session when a rotated token is replayed', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });
      const first = await http.refresh(browser(tokens.refreshToken));

      const replay = await http.refresh(browser(tokens.refreshToken));
      const latest = await http.refresh(browser(cookieValue(first)));

      expect(replay.status).toBe(401);
      expect(header(replay, 'Set-Cookie')).toEqual([CLEARED]);
      expect(latest.status).toBe(401);
    });

    it('keeps the cookie on a 503', async () => {
      const { auth, http, store } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });
      store.failRotate = true;

      const response = await http.refresh(browser(tokens.refreshToken));

      expect(response.status).toBe(503);
      expect(header(response, 'Set-Cookie')).toEqual([]);
      store.failRotate = false;
      expect((await http.refresh(browser(tokens.refreshToken))).status).toBe(
        200,
      );
    });

    it('clears the cookie with a 401 when onRefresh rejects the session', async () => {
      const { auth, http } = setup({ onRefresh: () => null });
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = await http.refresh(browser(tokens.refreshToken));

      expect(response.status).toBe(401);
      expect(header(response, 'Set-Cookie')).toEqual([CLEARED]);
      expect(await auth.listSessions('u1')).toEqual([]);
    });

    it('keeps the cookie with a 503 when onRefresh throws', async () => {
      let fail = true;
      const { auth, http } = setup({
        onRefresh: () => {
          if (fail) throw new Error('user db down');
        },
      });
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = await http.refresh(browser(tokens.refreshToken));

      expect(response.status).toBe(503);
      expect(header(response, 'Set-Cookie')).toEqual([]);
      fail = false;
      expect((await http.refresh(browser(tokens.refreshToken))).status).toBe(
        200,
      );
    });

    it('lets non-auth errors propagate', async () => {
      const { auth } = setup();
      const http = createToklynHttp(auth, {
        allowedOrigins: [ORIGIN],
        clock: {
          now: () => {
            throw new Error('clock broke');
          },
        },
      });
      const tokens = await auth.createSession({ subject: 'u1' });

      await expect(http.refresh(browser(tokens.refreshToken))).rejects.toThrow(
        'clock broke',
      );
    });
  });

  describe('logout', () => {
    it('revokes the session and clears the cookie', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = await http.logout(browser(tokens.refreshToken));

      expect(response).toEqual({
        status: 204,
        headers: [
          ['Set-Cookie', CLEARED],
          ['Cache-Control', 'no-store'],
        ],
        body: null,
      });
      expect(await auth.listSessions('u1')).toEqual([]);
    });

    it('succeeds without a cookie or with a dead one', async () => {
      const { http } = setup();
      expect((await http.logout(browser())).status).toBe(204);
      expect((await http.logout(browser('stale'))).status).toBe(204);
    });

    it('rejects cross-site requests and keeps the session', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = await http.logout(
        request({
          origin: 'https://evil.example',
          cookie: `${COOKIE}=${tokens.refreshToken}`,
        }),
      );

      expect(response.status).toBe(403);
      expect(await auth.listSessions('u1')).toHaveLength(1);
    });

    it('reports a 503 but still clears the cookie when storage fails', async () => {
      const { auth, http, store } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });
      store.failRotate = true;

      const response = await http.logout(browser(tokens.refreshToken));

      expect(response.status).toBe(503);
      expect(header(response, 'Set-Cookie')).toEqual([CLEARED]);
    });
  });
});

describe('createToklynHttp in cookie mode', () => {
  const ACCESS = '__Host-toklyn_access';
  const CLEARED_LAX = [
    `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    `${ACCESS}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  ];

  function cookieSetup(overrides: Partial<AuthConfig> = {}) {
    const ctx = setup({ reuseGraceMs: 10_000, ...overrides });
    const http = createToklynHttp(ctx.auth, {
      accessToken: 'cookie',
      allowedOrigins: [ORIGIN],
      clock: ctx.clock,
    });
    return { ...ctx, http };
  }

  function cookies(
    tokens: { accessToken?: string; refreshToken?: string },
    extra = 'theme=dark',
  ): string {
    return [
      extra,
      ...(tokens.refreshToken ? [`${COOKIE}=${tokens.refreshToken}`] : []),
      ...(tokens.accessToken ? [`${ACCESS}=${tokens.accessToken}`] : []),
    ].join('; ');
  }

  function page(cookie: string, method = 'GET'): ToklynHttpRequest {
    return request({ cookie }, method);
  }

  function configCode(run: () => unknown) {
    try {
      run();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  }

  describe('options', () => {
    it('requires a reuse grace period', () => {
      const { auth } = setup();
      expect(
        configCode(() => createToklynHttp(auth, { accessToken: 'cookie' })),
      ).toBe('invalid_config');
    });

    it.each([
      { accessToken: 'jwt' as 'cookie' },
      { accessCookie: { name: 'at' } },
      {
        accessToken: 'cookie' as const,
        cookie: { name: 'x' },
        accessCookie: { name: 'x' },
      },
      { accessToken: 'cookie' as const, accessCookie: { path: 'x' } },
      {
        accessToken: 'cookie' as const,
        accessCookie: { sameSite: 'None' as const },
      },
      { cookie: { sameSite: 'None' as const } },
      {
        cookie: { sameSite: 'None' as const, secure: false },
        allowedOrigins: [ORIGIN],
      },
    ])('rejects %j', (options) => {
      const { auth } = setup({ reuseGraceMs: 10_000 });
      expect(configCode(() => createToklynHttp(auth, options))).toBe(
        'invalid_config',
      );
    });

    it('allows SameSite=None with an allow-list', () => {
      const { auth } = setup({ reuseGraceMs: 10_000 });
      const http = createToklynHttp(auth, {
        accessToken: 'cookie',
        accessCookie: { sameSite: 'None' },
        cookie: { sameSite: 'None' },
        allowedOrigins: [ORIGIN],
      });
      expect(http.accessCookieName).toBe(ACCESS);
    });

    it('keeps resolve and readClaims to cookie mode', async () => {
      const { http } = setup();
      expect(http.accessCookieName).toBeNull();
      await expect(http.resolve(page(''))).rejects.toMatchObject({
        code: 'invalid_config',
      });
      await expect(http.readClaims('')).rejects.toMatchObject({
        code: 'invalid_config',
      });
    });
  });

  it('issues both cookies and keeps the access token out of the body', async () => {
    const { auth, http } = cookieSetup();
    const tokens = await auth.createSession({ subject: 'u1' });

    const response = http.issue(tokens);

    expect(header(response, 'Set-Cookie')).toEqual([
      `${COOKIE}=${tokens.refreshToken}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `${ACCESS}=${tokens.accessToken}; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expect(response.body).toEqual({
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      sessionId: tokens.sessionId,
    });
  });

  describe('authenticate', () => {
    it('reads the access cookie and ignores Bearer headers', async () => {
      const { auth, http } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const ok = await http.authenticate(page(cookies(tokens)));
      const bearer = await http.authenticate(
        request({ authorization: `Bearer ${tokens.accessToken}` }, 'GET'),
      );

      expect(ok.ok && ok.claims.sub).toBe('u1');
      expect(bearer).toEqual({
        ok: false,
        response: {
          status: 401,
          headers: [['Cache-Control', 'no-store']],
          body: UNAUTHORIZED,
        },
      });
    });

    it('needs a trusted origin for writes', async () => {
      const { auth, http } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });
      const cookie = cookies(tokens);

      for (const method of ['POST', 'put', 'PATCH', 'DELETE']) {
        for (const headers of [
          { cookie },
          { cookie, origin: 'https://evil.example' },
          { cookie, 'sec-fetch-site': 'same-site' },
        ] as Record<string, string>[]) {
          const result = await http.authenticate(request(headers, method));
          expect(!result.ok && result.response.status).toBe(403);
        }
        const trusted = await http.authenticate(
          request({ cookie, origin: ORIGIN }, method),
        );
        expect(trusted.ok).toBe(true);
      }
      for (const method of ['GET', 'head', 'OPTIONS']) {
        expect((await http.authenticate(page(cookie, method))).ok).toBe(true);
      }
    });
  });

  describe('authenticateOptional', () => {
    it('reads the access cookie and treats untrusted writes as guests', async () => {
      const { auth, http } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });
      const cookie = cookies(tokens);

      const read = await http.authenticateOptional(page(cookie));
      const trusted = await http.authenticateOptional(
        request({ cookie, origin: ORIGIN }, 'POST'),
      );
      const crossSite = await http.authenticateOptional(
        request({ cookie, origin: 'https://evil.example' }, 'POST'),
      );

      expect(read.ok && read.claims?.sub).toBe('u1');
      expect(trusted.ok && trusted.claims?.sub).toBe('u1');
      expect(crossSite).toEqual({ ok: true, claims: null });
      expect(await http.authenticateOptional(page('theme=dark'))).toEqual({
        ok: true,
        claims: null,
      });
    });

    it('answers 401 or ignores an invalid access cookie', async () => {
      const { http } = cookieSetup();
      const cookie = cookies({ accessToken: 'nope' });

      const rejected = await http.authenticateOptional(page(cookie));
      const ignored = await http.authenticateOptional(page(cookie), {
        invalidToken: 'ignore',
      });

      expect(!rejected.ok && rejected.response.status).toBe(401);
      expect(ignored).toEqual({ ok: true, claims: null });
    });
  });

  it('rotates and clears both cookies on refresh and logout', async () => {
    const { auth, http } = cookieSetup();
    const tokens = await auth.createSession({ subject: 'u1' });

    const refreshed = await http.refresh(
      request({ origin: ORIGIN, cookie: cookies(tokens) }),
    );
    const failed = await http.refresh(request({ origin: ORIGIN }));
    const loggedOut = await http.logout(
      request({ origin: ORIGIN, cookie: cookies(tokens) }),
    );

    expect(header(refreshed, 'Set-Cookie')).toHaveLength(2);
    expect(refreshed.body).not.toHaveProperty('accessToken');
    expect(header(failed, 'Set-Cookie')).toEqual(CLEARED_LAX);
    expect(header(loggedOut, 'Set-Cookie')).toEqual(CLEARED_LAX);
  });

  describe('resolve', () => {
    it('passes a valid access cookie through untouched', async () => {
      const { auth, http } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });
      const cookie = cookies(tokens);

      const result = await http.resolve(page(cookie));

      expect(result).toMatchObject({
        status: 'authenticated',
        claims: { sub: 'u1' },
        headers: [],
        cookie,
      });
    });

    it('refreshes an expired access cookie and forwards the new tokens', async () => {
      const { auth, http, clock } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });
      clock.time += 901_000;

      const result = await http.resolve(page(cookies(tokens)));

      expect(result.status).toBe('authenticated');
      const [refreshCookie, accessCookie] = header(
        { status: 200, headers: result.headers, body: null },
        'Set-Cookie',
      );
      const newRefresh = /^[^=]+=([^;]*)/.exec(refreshCookie ?? '')?.[1];
      const newAccess = /^[^=]+=([^;]*)/.exec(accessCookie ?? '')?.[1];
      expect(newRefresh).not.toBe(tokens.refreshToken);
      expect(result.cookie).toBe(
        `theme=dark; ${COOKIE}=${newRefresh}; ${ACCESS}=${newAccess}`,
      );
      expect(result.headers).toContainEqual(['Cache-Control', 'no-store']);
      expect(await http.readClaims(result.cookie)).toMatchObject({
        sub: 'u1',
      });
    });

    it('survives parallel refreshes within the grace period', async () => {
      const { auth, http, clock } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });
      clock.time += 901_000;
      const cookie = cookies({ refreshToken: tokens.refreshToken });

      const results = await Promise.all([
        http.resolve(page(cookie)),
        http.resolve(page(cookie)),
        http.resolve(page(cookie)),
      ]);

      expect(results.map((r) => r.status)).toEqual([
        'authenticated',
        'authenticated',
        'authenticated',
      ]);
      expect(await auth.listSessions('u1')).toHaveLength(1);
    });

    it('signs out and strips auth cookies when the refresh token is bad', async () => {
      const { http } = cookieSetup();

      const none = await http.resolve(page('theme=dark'));
      const bad = await http.resolve(
        page(cookies({ accessToken: 'x.y.z', refreshToken: 'stale' })),
      );
      const empty = await http.resolve(page(''));

      expect(none).toEqual({
        status: 'unauthenticated',
        headers: [],
        cookie: 'theme=dark',
      });
      expect(bad.status).toBe('unauthenticated');
      expect(bad.cookie).toBe('theme=dark');
      expect(
        header({ status: 401, headers: bad.headers, body: null }, 'Set-Cookie'),
      ).toEqual(CLEARED_LAX);
      expect(empty.cookie).toBeNull();
    });

    it('treats cross-site writes as signed out without touching tokens', async () => {
      const { auth, http, clock } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });
      clock.time += 901_000;

      const result = await http.resolve(
        request(
          { cookie: cookies(tokens), origin: 'https://evil.example' },
          'POST',
        ),
      );

      expect(result).toEqual({
        status: 'unauthenticated',
        headers: [],
        cookie: 'theme=dark',
      });
      const later = await http.resolve(page(cookies(tokens)));
      expect(later.status).toBe('authenticated');
    });

    it('reports storage errors and keeps the cookies', async () => {
      const { auth, http, clock, store } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });
      clock.time += 901_000;
      store.failRotate = true;
      const cookie = cookies(tokens);

      const result = await http.resolve(page(cookie));

      expect(result).toEqual({
        status: 'unavailable',
        headers: [['Cache-Control', 'no-store']],
        cookie,
      });
    });

    it('still sends rotated cookies when online verification fails afterwards', async () => {
      const { auth, http, clock, store } = cookieSetup({
        verification: 'online',
      });
      const tokens = await auth.createSession({ subject: 'u1' });
      clock.time += 901_000;
      store.failFind = true;

      const result = await http.resolve(page(cookies(tokens)));

      expect(result.status).toBe('unavailable');
      expect(
        result.headers.filter(([name]) => name === 'Set-Cookie'),
      ).toHaveLength(2);
    });
  });

  describe('readClaims', () => {
    it('returns claims, or null when missing or expired', async () => {
      const { auth, http, clock } = cookieSetup();
      const tokens = await auth.createSession({ subject: 'u1' });

      expect(await http.readClaims(cookies(tokens))).toMatchObject({
        sub: 'u1',
      });
      expect(await http.readClaims(null)).toBeNull();
      clock.time += 901_000;
      expect(await http.readClaims(cookies(tokens))).toBeNull();
    });

    it('throws when online verification cannot reach storage', async () => {
      const { auth, http, store } = cookieSetup({ verification: 'online' });
      const tokens = await auth.createSession({ subject: 'u1' });
      store.failFind = true;

      await expect(http.readClaims(cookies(tokens))).rejects.toMatchObject({
        code: 'storage_error',
      });
    });
  });
});
