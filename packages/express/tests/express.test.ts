import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  RemoteJwksAccessTokenVerifier,
  createAuth,
  createJwks,
} from 'toklyn';
import type { ToklynHttpOptions } from 'toklyn/http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createToklynExpress,
  createToklynExpressResource,
  getAuth,
  getOptionalAuth,
  jwksHandler,
} from '#src/index.js';

const ORIGIN = 'https://app.example.com';
const COOKIE = '__Host-toklyn_refresh';
const keyConfig = {
  keys: [{ algorithm: 'HS256' as const, secret: new Uint8Array(32).fill(5) }],
};

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function startApp(options: ToklynHttpOptions = {}) {
  const sessions = new MemorySessionStore();
  const auth = createAuth<{ role: string }>({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    sessionMaxAgeSeconds: 86_400,
    reuseGraceMs: options.accessToken === 'cookie' ? 10_000 : 0,
  });
  const toklyn = createToklynExpress(auth, {
    allowedOrigins: [ORIGIN],
    ...options,
  });

  const app = express();
  app.post('/login', async (_req, res) => {
    const tokens = await auth.createSession({
      subject: 'u1',
      claims: { role: 'admin' },
    });
    toklyn.sendSession(res, tokens);
  });
  app.post('/auth/refresh', toklyn.refreshHandler);
  app.post('/auth/logout', toklyn.logoutHandler);
  app.get('/me', toklyn.requireAuth, (req, res) => {
    const { sub, role } = getAuth<{ role: string }>(req);
    res.json({ sub, role });
  });
  app.post('/notes', toklyn.requireAuth, (req, res) => {
    res.status(201).json({ by: getAuth(req).sub });
  });
  app.get('/unguarded', (req, res) => {
    res.json(getAuth(req));
  });
  app.get('/feed', toklyn.optionalAuth(), (req, res) => {
    res.json({ sub: getOptionalAuth(req)?.sub ?? null });
  });
  app.get(
    '/feed-lenient',
    toklyn.optionalAuth({ invalidToken: 'ignore' }),
    (req, res) => {
      res.json({ sub: getOptionalAuth(req)?.sub ?? null });
    },
  );
  app.get('/guest-getauth', toklyn.optionalAuth(), (req, res) => {
    res.json(getAuth(req));
  });
  const onError: ErrorRequestHandler = (error: Error, _req, res, _next) => {
    res.status(500).json({ error: error.message });
  };
  app.use(onError);

  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    auth,
    call: (path: string, init: RequestInit = {}) => fetch(base + path, init),
  };
}

async function login(call: Awaited<ReturnType<typeof startApp>>['call']) {
  const response = await call('/login', { method: 'POST' });
  const body = (await response.json()) as { accessToken: string };
  return {
    response,
    accessToken: body.accessToken,
    refreshToken: cookieValue(response),
  };
}

function cookieValue(response: Response): string {
  const [setCookie] = response.headers.getSetCookie();
  return /^[^=]+=([^;]*)/.exec(setCookie ?? '')?.[1] ?? '';
}

function fromBrowser(refreshToken: string, origin = ORIGIN): RequestInit {
  return {
    method: 'POST',
    headers: { origin, cookie: `${COOKIE}=${refreshToken}` },
  };
}

describe('@toklyn/express', () => {
  it('supports cookie mode with an origin check on writes', async () => {
    const { call } = await startApp({ accessToken: 'cookie' });

    const response = await call('/login', { method: 'POST' });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');

    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(await response.json()).not.toHaveProperty('accessToken');
    expect((await call('/me', { headers: { cookie } })).status).toBe(200);
    const crossSite = await call('/notes', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(403);
    const sameSite = await call('/notes', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN },
    });
    expect(sameSite.status).toBe(201);
    expect(await sameSite.json()).toEqual({ by: 'u1' });
  });
  it('logs in with an HttpOnly cookie and a JSON access token', async () => {
    const { call } = await startApp();

    const { response, accessToken, refreshToken } = await login(call);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [setCookie] = response.headers.getSetCookie();
    // Max-Age is rounded down from the expiry, so a millisecond tick can make it 3599.
    expect(setCookie).toMatch(
      new RegExp(
        `^${COOKIE}=${refreshToken}; Max-Age=(3599|3600); Path=/; HttpOnly; Secure; SameSite=Strict$`,
      ),
    );
    expect(accessToken.split('.')).toHaveLength(3);
  });

  it('exposes claims to handlers behind requireAuth', async () => {
    const { call } = await startApp();
    const { accessToken } = await login(call);

    const response = await call('/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: 'u1', role: 'admin' });
  });

  it('returns an identical 401 for every kind of bad Bearer token', async () => {
    const { call } = await startApp();
    const { accessToken } = await login(call);

    const bodies = new Set<string>();
    for (const authorization of [
      undefined,
      accessToken,
      `Basic ${accessToken}`,
      `Bearer ${accessToken.slice(0, -2)}`,
      'Bearer not.a.jwt',
    ]) {
      const response = await call('/me', {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
  });

  it('rotates the refresh cookie and detects reuse', async () => {
    const { call } = await startApp();
    const { refreshToken } = await login(call);

    const first = await call('/auth/refresh', fromBrowser(refreshToken));
    const rotated = cookieValue(first);
    const replay = await call('/auth/refresh', fromBrowser(refreshToken));
    const afterReuse = await call('/auth/refresh', fromBrowser(rotated));

    expect(first.status).toBe(200);
    expect(rotated).not.toBe(refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.headers.getSetCookie()).toEqual([
      `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
    ]);
    expect(afterReuse.status).toBe(401);
  });

  it('blocks cross-site refresh and logout', async () => {
    const { auth, call } = await startApp();
    const { refreshToken } = await login(call);

    for (const path of ['/auth/refresh', '/auth/logout']) {
      const response = await call(
        path,
        fromBrowser(refreshToken, 'https://evil.example'),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    }
    expect(await auth.listSessions('u1')).toHaveLength(1);
  });

  it('logs out by revoking the session and clearing the cookie', async () => {
    const { auth, call } = await startApp();
    const { refreshToken } = await login(call);

    const response = await call('/auth/logout', fromBrowser(refreshToken));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.getSetCookie()).toEqual([
      `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`,
    ]);
    expect(await auth.listSessions('u1')).toEqual([]);
  });

  it('lets guests through optionalAuth and still rejects bad tokens by default', async () => {
    const { call } = await startApp();
    const { accessToken } = await login(call);
    const bad = { headers: { authorization: 'Bearer not.a.jwt' } };

    const signedIn = await call('/feed', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const guest = await call('/feed');
    const rejected = await call('/feed', bad);
    const ignored = await call('/feed-lenient', bad);

    expect(await signedIn.json()).toEqual({ sub: 'u1' });
    expect(await guest.json()).toEqual({ sub: null });
    expect(rejected.status).toBe(401);
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ sub: null });
    expect((await call('/guest-getauth')).status).toBe(500);
  });

  it('fails loudly when getAuth runs without requireAuth', async () => {
    const { call } = await startApp();

    const response = await call('/unguarded');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'getAuth() needs requireAuth to run first on this route',
    });
  });
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('@toklyn/express with JWKS', () => {
  async function startPair() {
    const { privateKey, publicKey } = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const keys = {
      keys: [{ kid: 'k1', algorithm: 'ES256' as const, privateKey, publicKey }],
    };
    const auth = createAuth<{ role: string }>({
      signer: new JwtAccessTokenSigner(keys),
      verifier: new JwtAccessTokenVerifier(keys),
      sessions: new MemorySessionStore(),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      sessionMaxAgeSeconds: 86_400,
    });

    const authApp = express();
    authApp.get(
      '/.well-known/jwks.json',
      jwksHandler(await createJwks(keys.keys)),
    );
    const authBase = await listen(authApp);

    const resource = createToklynExpressResource(
      new RemoteJwksAccessTokenVerifier({
        url: `${authBase}/.well-known/jwks.json`,
        algorithms: ['ES256'],
      }),
    );
    const api = express();
    api.get('/me', resource.requireAuth, (req, res) => {
      const { sub, role } = getAuth<{ role: string }>(req);
      res.json({ sub, role });
    });
    api.get('/feed', resource.optionalAuth(), (req, res) => {
      res.json({ sub: getOptionalAuth(req)?.sub ?? null });
    });
    const apiBase = await listen(api);

    return { auth, authBase, apiBase };
  }

  it('serves the public keys with a cache header', async () => {
    const { authBase } = await startPair();
    const response = await fetch(`${authBase}/.well-known/jwks.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await response.json()) as { keys: object[] };
    expect(body.keys).toEqual([
      expect.objectContaining({ kid: 'k1', alg: 'ES256', kty: 'EC' }),
    ]);
    expect(body.keys[0]).not.toHaveProperty('d');
  });

  it('verifies tokens on another service through the JWKS', async () => {
    const { auth, apiBase } = await startPair();
    const { accessToken } = await auth.createSession({
      subject: 'u1',
      claims: { role: 'admin' },
    });

    const me = await fetch(`${apiBase}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(await me.json()).toEqual({ sub: 'u1', role: 'admin' });

    const anonymous = await fetch(`${apiBase}/me`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    expect(await (await fetch(`${apiBase}/feed`)).json()).toEqual({
      sub: null,
    });
  });

  it('answers 503 when the JWKS is unreachable', async () => {
    const api = express();
    const resource = createToklynExpressResource(
      new RemoteJwksAccessTokenVerifier({
        url: 'http://127.0.0.1:1/.well-known/jwks.json',
        algorithms: ['ES256'],
      }),
    );
    api.get('/me', resource.requireAuth, (_req, res) => {
      res.json({});
    });
    const apiBase = await listen(api);
    const part = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${part({ alg: 'ES256', kid: 'k1' })}.${part({ sub: 'u1' })}.c2ln`;

    const response = await fetch(`${apiBase}/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
  });
});
