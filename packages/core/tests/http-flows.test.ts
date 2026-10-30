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

function request(headers: Record<string, string> = {}): ToklynHttpRequest {
  return { header: (name) => headers[name] };
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

  describe('refresh', () => {
    it('rotates the cookie and returns a new access token', async () => {
      const { auth, http } = setup();
      const tokens = await auth.createSession({ subject: 'u1' });

      const response = await http.refresh(browser(tokens.refreshToken));

      expect(response.status).toBe(200);
      const rotated = cookieValue(response);
      expect(rotated).not.toBe(tokens.refreshToken);
      expect(rotated).toHaveLength(43);
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
