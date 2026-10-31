import { NextRequest } from 'next/server';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  createAuth,
} from 'toklyn';
import type { AuthConfig } from 'toklyn';
import { describe, expect, it, vi } from 'vitest';
import { createToklynServer } from '#src/server.js';

const incoming = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({
  headers: async () => incoming.headers,
}));

const BASE = 'https://app.example.com';
const REFRESH = '__Host-toklyn_refresh';
const ACCESS = '__Host-toklyn_access';
const keyConfig = {
  keys: [{ algorithm: 'HS256' as const, secret: new Uint8Array(32).fill(4) }],
};

class FakeClock {
  time = 1_700_000_000_000;
  now = () => this.time;
}

class FlakyStore extends MemorySessionStore {
  down = false;
  override async rotate(input: Parameters<MemorySessionStore['rotate']>[0]) {
    if (this.down) throw new Error('db down');
    return super.rotate(input);
  }
}

function makeAuth(overrides: Partial<AuthConfig<{ role: string }>> = {}) {
  const clock = new FakeClock();
  const store = new FlakyStore();
  const auth = createAuth<{ role: string }>({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions: store,
    clock,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    sessionMaxAgeSeconds: 86_400,
    reuseGraceMs: 10_000,
    ...overrides,
  });
  return { auth, clock, store };
}

function setup(isPublic?: (pathname: string) => boolean) {
  const ctx = makeAuth();
  const toklyn = createToklynServer(ctx.auth, {
    loginPath: '/login',
    allowedOrigins: [BASE],
    clock: ctx.clock,
    ...(isPublic ? { isPublic } : {}),
  });
  return { ...ctx, toklyn };
}

async function signIn(ctx: ReturnType<typeof setup>) {
  const tokens = await ctx.auth.createSession({
    subject: 'u1',
    claims: { role: 'admin' },
  });
  return {
    tokens,
    cookie: `theme=dark; ${REFRESH}=${tokens.refreshToken}; ${ACCESS}=${tokens.accessToken}`,
  };
}

const PAGE = { accept: 'text/html', 'sec-fetch-dest': 'document' };

function visit(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
) {
  return new NextRequest(BASE + path, {
    method,
    headers: { ...PAGE, ...headers },
  });
}

function forwardedCookie(response: Response): string | null | undefined {
  const names = response.headers.get('x-middleware-override-headers');
  if (names === null) return undefined;
  if (!names.split(',').includes('cookie')) return null;
  return response.headers.get('x-middleware-request-cookie');
}

function isPassThrough(response: Response): boolean {
  return response.headers.get('x-middleware-next') === '1';
}

describe('createToklynServer', () => {
  it.each(['login', '//evil.example', 'https://evil.example', '/a\\b'])(
    'rejects loginPath %j',
    (loginPath) => {
      const { auth } = makeAuth();
      expect(() => createToklynServer(auth, { loginPath })).toThrow(
        'loginPath',
      );
    },
  );

  it('needs a reuse grace period', () => {
    const { auth } = makeAuth({ reuseGraceMs: 0 });
    expect(() => createToklynServer(auth, { loginPath: '/login' })).toThrow(
      'reuseGraceMs',
    );
  });

  it('logs in with two cookies and no token in the body', async () => {
    const ctx = setup();
    const tokens = await ctx.auth.createSession({ subject: 'u1' });

    const response = ctx.toklyn.sessionResponse(tokens);

    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(await response.json()).not.toHaveProperty('accessToken');
  });

  describe('proxy', () => {
    it('lets a signed-in visit through untouched', async () => {
      const ctx = setup();
      const { cookie } = await signIn(ctx);

      const response = await ctx.toklyn.proxy(visit('/dashboard', { cookie }));

      expect(isPassThrough(response)).toBe(true);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(forwardedCookie(response)).toBe(cookie);
    });

    it('refreshes an expired access cookie and forwards the new one', async () => {
      const ctx = setup();
      const { cookie, tokens } = await signIn(ctx);
      ctx.clock.time += 901_000;

      const response = await ctx.toklyn.proxy(visit('/dashboard', { cookie }));

      expect(isPassThrough(response)).toBe(true);
      const setCookies = response.headers.getSetCookie();
      expect(setCookies).toHaveLength(2);
      const forwarded = forwardedCookie(response) ?? '';
      expect(forwarded).toMatch(/^theme=dark; __Host-toklyn_refresh=/);
      expect(forwarded).not.toContain(tokens.refreshToken);
      for (const setCookie of setCookies) {
        expect(forwarded).toContain(setCookie.split(';')[0]);
      }
    });

    it('redirects signed-out page visits and keeps the path', async () => {
      const ctx = setup();

      const document = await ctx.toklyn.proxy(visit('/dashboard?tab=1'));
      const rsc = await ctx.toklyn.proxy(
        new NextRequest(`${BASE}/settings`, { headers: { rsc: '1' } }),
      );

      expect(document.status).toBe(307);
      expect(document.headers.get('location')).toBe(
        `${BASE}/login?from=%2Fdashboard%3Ftab%3D1`,
      );
      expect(rsc.status).toBe(307);
    });

    it('clears dead cookies on the redirect', async () => {
      const ctx = setup();

      const response = await ctx.toklyn.proxy(
        visit('/dashboard', { cookie: `${REFRESH}=stale; ${ACCESS}=x.y.z` }),
      );

      expect(response.status).toBe(307);
      expect(response.headers.getSetCookie()).toEqual([
        `${REFRESH}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
        `${ACCESS}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
      ]);
    });

    it('shows public pages and passes other requests through when signed out', async () => {
      const ctx = setup((pathname) => ['/login', '/'].includes(pathname));

      const login = await ctx.toklyn.proxy(visit('/login'));
      const home = await ctx.toklyn.proxy(visit('/', { cookie: 'theme=dark' }));
      const api = await ctx.toklyn.proxy(
        new NextRequest(`${BASE}/api/me`, {
          headers: { accept: 'application/json' },
        }),
      );

      expect(isPassThrough(login)).toBe(true);
      expect(isPassThrough(home)).toBe(true);
      expect(forwardedCookie(home)).toBe('theme=dark');
      expect(isPassThrough(api)).toBe(true);
    });

    it('does not forward auth cookies on cross-site writes', async () => {
      const ctx = setup();
      const { cookie } = await signIn(ctx);

      const response = await ctx.toklyn.proxy(
        visit('/api/notes', { cookie, origin: 'https://evil.example' }, 'POST'),
      );

      expect(isPassThrough(response)).toBe(true);
      expect(forwardedCookie(response)).toBe('theme=dark');
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('answers 503 when storage is down', async () => {
      const ctx = setup();
      const { cookie } = await signIn(ctx);
      ctx.clock.time += 901_000;
      ctx.store.down = true;

      const response = await ctx.toklyn.proxy(visit('/dashboard', { cookie }));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'service_unavailable' });
    });
  });

  describe('getClaims and requireClaims', () => {
    it('read the access cookie from the request headers', async () => {
      const ctx = setup();
      const { cookie } = await signIn(ctx);
      incoming.headers = new Headers({ cookie });

      expect(await ctx.toklyn.getClaims()).toMatchObject({
        sub: 'u1',
        role: 'admin',
      });
      expect(await ctx.toklyn.requireClaims()).toMatchObject({ sub: 'u1' });
    });

    it('return null or redirect when signed out', async () => {
      const ctx = setup();
      incoming.headers = new Headers();

      expect(await ctx.toklyn.getClaims()).toBeNull();
      await expect(ctx.toklyn.requireClaims()).rejects.toMatchObject({
        digest: expect.stringContaining(';/login;'),
      });
    });
  });
});
