import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  RemoteJwksAccessTokenVerifier,
  createAuth,
  createJwks,
} from 'toklyn';
import { describe, expect, it } from 'vitest';
import {
  createToklynNext,
  createToklynNextResource,
  jwksRoute,
} from '#src/index.js';

const BASE = 'https://app.example.com';
const COOKIE = '__Host-toklyn_refresh';
const CLEARED = `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
const keyConfig = {
  keys: [{ algorithm: 'HS256' as const, secret: new Uint8Array(32).fill(9) }],
};

class FlakyStore extends MemorySessionStore {
  down = false;
  override async rotate(input: Parameters<MemorySessionStore['rotate']>[0]) {
    if (this.down) throw new Error('db down');
    return super.rotate(input);
  }
}

type RouteContext = { params: Promise<{ id: string }> };

function setup() {
  const store = new FlakyStore();
  const auth = createAuth<{ role: string }>({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions: store,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    sessionMaxAgeSeconds: 86_400,
  });
  const toklyn = createToklynNext(auth, { allowedOrigins: [BASE] });

  // What an app's route files would export.
  const routes = {
    login: async () =>
      toklyn.sessionResponse(
        await auth.createSession({ subject: 'u1', claims: { role: 'admin' } }),
      ),
    refresh: toklyn.refresh,
    logout: toklyn.logout,
    item: toklyn.withAuth<Request, RouteContext>(
      async (request, { params, claims }) => {
        const { id } = await params;
        return Response.json({
          id,
          sub: claims.sub,
          role: claims.role,
          path: new URL(request.url).pathname,
        });
      },
    ),
    broken: toklyn.withAuth(() => {
      throw new Error('handler failed');
    }),
    feed: toklyn.withOptionalAuth<Request, RouteContext>(
      async (_request, { params, claims }) =>
        Response.json({ id: (await params).id, role: claims?.role ?? null }),
    ),
    feedLenient: toklyn.withOptionalAuth(
      (_request, { claims }) => Response.json({ sub: claims?.sub ?? null }),
      { invalidToken: 'ignore' },
    ),
  };
  return { auth, store, routes };
}

async function login(routes: ReturnType<typeof setup>['routes']) {
  const response = await routes.login();
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

function fromBrowser(path: string, refreshToken: string, origin = BASE) {
  return new Request(BASE + path, {
    method: 'POST',
    headers: { origin, cookie: `${COOKIE}=${refreshToken}` },
  });
}

function getItem(authorization?: string) {
  return new Request(`${BASE}/items/42`, {
    headers: authorization ? { authorization } : {},
  });
}

const context: RouteContext = { params: Promise.resolve({ id: '42' }) };

describe('@toklyn/next', () => {
  it('logs in with an HttpOnly cookie and a JSON access token', async () => {
    const { routes } = setup();

    const { response, accessToken, refreshToken } = await login(routes);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    // Max-Age is rounded down from the expiry, so a millisecond tick can make it 3599.
    expect(response.headers.getSetCookie()[0]).toMatch(
      new RegExp(
        `^${COOKIE}=${refreshToken}; Max-Age=(3599|3600); Path=/; HttpOnly; Secure; SameSite=Strict$`,
      ),
    );
    expect(accessToken.split('.')).toHaveLength(3);
  });

  it('passes claims and the route context to wrapped handlers', async () => {
    const { routes } = setup();
    const { accessToken } = await login(routes);

    const response = await routes.item(
      getItem(`Bearer ${accessToken}`),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: '42',
      sub: 'u1',
      role: 'admin',
      path: '/items/42',
    });
  });

  it('lets guests through withOptionalAuth and still rejects bad tokens by default', async () => {
    const { routes } = setup();
    const { accessToken } = await login(routes);

    const signedIn = await routes.feed(
      getItem(`Bearer ${accessToken}`),
      context,
    );
    const guest = await routes.feed(getItem(), context);
    const rejected = await routes.feed(getItem('Bearer not.a.jwt'), context);
    const ignored = await routes.feedLenient(getItem('Bearer not.a.jwt'), {});

    expect(await signedIn.json()).toEqual({ id: '42', role: 'admin' });
    expect(await guest.json()).toEqual({ id: '42', role: null });
    expect(rejected.status).toBe(401);
    expect(await ignored.json()).toEqual({ sub: null });
  });

  it('returns an identical 401 for every kind of bad Bearer token', async () => {
    const { routes } = setup();
    const { accessToken } = await login(routes);

    const bodies = new Set<string>();
    for (const authorization of [
      undefined,
      accessToken,
      `Basic ${accessToken}`,
      `Bearer ${accessToken.slice(0, -2)}`,
      'Bearer not.a.jwt',
    ]) {
      const response = await routes.item(getItem(authorization), context);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.headers.get('cache-control')).toBe('no-store');
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
  });

  it('rotates the refresh cookie and detects reuse', async () => {
    const { routes } = setup();
    const { refreshToken } = await login(routes);

    const first = await routes.refresh(
      fromBrowser('/auth/refresh', refreshToken),
    );
    const rotated = cookieValue(first);
    const replay = await routes.refresh(
      fromBrowser('/auth/refresh', refreshToken),
    );
    const afterReuse = await routes.refresh(
      fromBrowser('/auth/refresh', rotated),
    );

    expect(first.status).toBe(200);
    expect(rotated).not.toBe(refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.headers.getSetCookie()).toEqual([CLEARED]);
    expect(afterReuse.status).toBe(401);
  });

  it('keeps the cookie when storage is down during refresh', async () => {
    const { routes, store } = setup();
    const { refreshToken } = await login(routes);
    store.down = true;

    const response = await routes.refresh(
      fromBrowser('/auth/refresh', refreshToken),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('blocks cross-site refresh and logout', async () => {
    const { auth, routes } = setup();
    const { refreshToken } = await login(routes);

    for (const [path, handler] of [
      ['/auth/refresh', routes.refresh],
      ['/auth/logout', routes.logout],
    ] as const) {
      const response = await handler(
        fromBrowser(path, refreshToken, 'https://evil.example'),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    }
    expect(await auth.listSessions('u1')).toHaveLength(1);
  });

  it('logs out by revoking the session and clearing the cookie', async () => {
    const { auth, routes } = setup();
    const { refreshToken } = await login(routes);

    const response = await routes.logout(
      fromBrowser('/auth/logout', refreshToken),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(await auth.listSessions('u1')).toEqual([]);
  });

  it('lets handler errors propagate to the framework', async () => {
    const { routes } = setup();
    const { accessToken } = await login(routes);

    await expect(
      routes.broken(getItem(`Bearer ${accessToken}`), {}),
    ).rejects.toThrow('handler failed');
  });
});

describe('@toklyn/next with JWKS', () => {
  async function setupPair() {
    const { privateKey, publicKey } = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const keys = [
      { kid: 'k1', algorithm: 'ES256' as const, privateKey, publicKey },
    ];
    const auth = createAuth<{ role: string }>({
      signer: new JwtAccessTokenSigner({ keys }),
      verifier: new JwtAccessTokenVerifier({ keys }),
      sessions: new MemorySessionStore(),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      sessionMaxAgeSeconds: 86_400,
    });
    const jwksGet = jwksRoute(await createJwks(keys));

    // The other service fetches the auth service's route handler directly.
    const resource = createToklynNextResource<{ role: string }>(
      new RemoteJwksAccessTokenVerifier({
        url: `${BASE}/.well-known/jwks.json`,
        algorithms: ['ES256'],
        fetch: async () => jwksGet(),
      }),
    );
    const item = resource.withAuth<Request, RouteContext>(
      async (_request, { params, claims }) =>
        Response.json({ id: (await params).id, role: claims.role }),
    );
    const feed = resource.withOptionalAuth((_request, { claims }) =>
      Response.json({ sub: claims?.sub ?? null }),
    );
    return { auth, jwksGet, item, feed };
  }

  it('serves the public keys as JSON with a cache header', async () => {
    const { jwksGet } = await setupPair();
    const response = jwksGet();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = (await response.json()) as { keys: object[] };
    expect(body.keys).toEqual([
      expect.objectContaining({ kid: 'k1', alg: 'ES256', use: 'sig' }),
    ]);
  });

  it('verifies tokens from the auth service', async () => {
    const { auth, item, feed } = await setupPair();
    const { accessToken } = await auth.createSession({
      subject: 'u1',
      claims: { role: 'admin' },
    });

    const ok = await item(getItem(`Bearer ${accessToken}`), context);
    expect(await ok.json()).toEqual({ id: '42', role: 'admin' });

    const anonymous = await item(getItem(), context);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    expect(await (await feed(getItem(), {})).json()).toEqual({ sub: null });
  });
});
