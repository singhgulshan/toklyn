import {
  Controller,
  Get,
  Inject,
  Module,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { AddressInfo } from 'node:net';
import 'reflect-metadata';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  createAuth,
} from 'toklyn';
import type { AccessTokenClaims, Auth } from 'toklyn';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToklynAuthGuard,
  ToklynClaims,
  ToklynModule,
  ToklynOptional,
  ToklynPublic,
  ToklynSessionService,
} from '#src/index.js';
import type { NodeStyleRequest } from '#src/index.js';

type Claims = { role: string };

const ORIGIN = 'https://app.example.com';
const COOKIE = '__Host-toklyn_refresh';
const CLEARED = `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
const AUTH = Symbol('auth');
const keyConfig = {
  keys: [{ algorithm: 'HS256' as const, secret: new Uint8Array(32).fill(3) }],
};

function makeAuth(reuseGraceMs = 0): Auth<Claims> {
  return createAuth<Claims>({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions: new MemorySessionStore(),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3600,
    sessionMaxAgeSeconds: 86_400,
    reuseGraceMs,
  });
}

@Controller()
class SessionController {
  constructor(
    @Inject(ToklynSessionService)
    private readonly sessions: ToklynSessionService,
    @Inject(AUTH) private readonly auth: Auth<Claims>,
  ) {}

  @ToklynPublic()
  @Post('login')
  async login(@Res() res: object): Promise<void> {
    const tokens = await this.auth.createSession({
      subject: 'u1',
      claims: { role: 'admin' },
    });
    this.sessions.sendSession(res, tokens);
  }

  @ToklynPublic()
  @Post('auth/refresh')
  refresh(@Req() req: NodeStyleRequest, @Res() res: object): Promise<void> {
    return this.sessions.refresh(req, res);
  }

  @ToklynPublic()
  @Post('auth/logout')
  logout(@Req() req: NodeStyleRequest, @Res() res: object): Promise<void> {
    return this.sessions.logout(req, res);
  }

  @Get('me')
  me(@ToklynClaims() claims: AccessTokenClaims<Claims>) {
    return { sub: claims.sub, role: claims.role };
  }

  @ToklynPublic()
  @Get('misconfigured')
  misconfigured(@ToklynClaims() claims: AccessTokenClaims) {
    return claims;
  }

  @ToklynOptional()
  @Get('feed')
  feed(@ToklynClaims() claims: AccessTokenClaims | null) {
    return { sub: claims?.sub ?? null };
  }

  @ToklynOptional({ invalidToken: 'ignore' })
  @Get('feed-lenient')
  feedLenient(@ToklynClaims() claims: AccessTokenClaims | null) {
    return { sub: claims?.sub ?? null };
  }
}

@ToklynPublic()
@Controller('open')
class OpenController {
  @Get()
  open() {
    return { ok: true };
  }
}

@Module({
  providers: [{ provide: AUTH, useFactory: makeAuth }],
  exports: [AUTH],
})
class AuthModule {}

/** Async registration with a global guard. */
@Module({
  imports: [
    AuthModule,
    ToklynModule.forRootAsync({
      imports: [AuthModule],
      inject: [AUTH],
      useFactory: (auth: Auth<Claims>) => ({ auth, allowedOrigins: [ORIGIN] }),
    }),
  ],
  controllers: [SessionController, OpenController],
  providers: [{ provide: APP_GUARD, useClass: ToklynAuthGuard }],
})
class GlobalGuardModule {}

@Controller('scoped')
class ScopedController {
  @Get('guarded')
  @UseGuards(ToklynAuthGuard)
  guarded(@ToklynClaims() claims: AccessTokenClaims) {
    return { sub: claims.sub };
  }

  @Get('free')
  free() {
    return { ok: true };
  }
}

const sharedAuth = makeAuth();

/** Sync registration with a per-route guard. */
@Module({
  imports: [ToklynModule.forRoot({ auth: sharedAuth })],
  controllers: [ScopedController],
})
class RouteGuardModule {}

@Controller()
class CookieController {
  constructor(
    @Inject(ToklynSessionService)
    private readonly sessions: ToklynSessionService,
  ) {}

  @ToklynPublic()
  @Post('login')
  async login(@Res() res: object): Promise<void> {
    this.sessions.sendSession(
      res,
      await cookieAuth.createSession({ subject: 'u1' }),
    );
  }

  @Get('me')
  me(@ToklynClaims() claims: AccessTokenClaims) {
    return { sub: claims.sub };
  }

  @Post('notes')
  note(@ToklynClaims() claims: AccessTokenClaims) {
    return { by: claims.sub };
  }
}

const cookieAuth = makeAuth(10_000);

@Module({
  imports: [
    ToklynModule.forRoot({
      auth: cookieAuth,
      accessToken: 'cookie',
      allowedOrigins: [ORIGIN],
    }),
  ],
  controllers: [CookieController],
  providers: [{ provide: APP_GUARD, useClass: ToklynAuthGuard }],
})
class CookieModeModule {}

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const platforms = {
  express: () => new ExpressAdapter(),
  fastify: () => new FastifyAdapter(),
};

describe.each(Object.entries(platforms))('@toklyn/nest on %s', (_, adapter) => {
  async function start(module: Type<unknown>) {
    const app = await NestFactory.create(module, adapter(), { logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    return {
      app,
      call: (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, init),
    };
  }

  async function login(
    call: (path: string, init?: RequestInit) => Promise<Response>,
  ) {
    const response = await call('/login', { method: 'POST' });
    const body = (await response.json()) as { accessToken: string };
    return {
      response,
      accessToken: body.accessToken,
      refreshToken: cookieValue(response),
    };
  }

  it('supports cookie mode with an origin check on writes', async () => {
    const { call } = await start(CookieModeModule);

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
    const { call } = await start(GlobalGuardModule);

    const { response, accessToken, refreshToken } = await login(call);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()[0]).toMatch(
      new RegExp(
        `^${COOKIE}=${refreshToken}; Max-Age=(3599|3600); Path=/; HttpOnly; Secure; SameSite=Strict$`,
      ),
    );
    expect(accessToken.split('.')).toHaveLength(3);
  });

  it('injects claims behind the global guard', async () => {
    const { call } = await start(GlobalGuardModule);
    const { accessToken } = await login(call);

    const response = await call('/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sub: 'u1', role: 'admin' });
  });

  it('returns an identical 401 for every kind of bad Bearer token', async () => {
    const { call } = await start(GlobalGuardModule);
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
      expect(response.headers.get('cache-control')).toBe('no-store');
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual(['{"error":"unauthorized"}']);
  });

  it('lets guests through @ToklynOptional() and still rejects bad tokens by default', async () => {
    const { call } = await start(GlobalGuardModule);
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
    expect(await ignored.json()).toEqual({ sub: null });
  });

  it('honours @ToklynPublic() on a controller', async () => {
    const { call } = await start(GlobalGuardModule);

    const response = await call('/open');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('rotates the refresh cookie and detects reuse', async () => {
    const { call } = await start(GlobalGuardModule);
    const { refreshToken } = await login(call);

    const first = await call('/auth/refresh', fromBrowser(refreshToken));
    const rotated = cookieValue(first);
    const replay = await call('/auth/refresh', fromBrowser(refreshToken));
    const afterReuse = await call('/auth/refresh', fromBrowser(rotated));

    expect(first.status).toBe(200);
    expect(rotated).not.toBe(refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.headers.getSetCookie()).toEqual([CLEARED]);
    expect(afterReuse.status).toBe(401);
  });

  it('blocks cross-site refresh and logout', async () => {
    const { app, call } = await start(GlobalGuardModule);
    const { refreshToken } = await login(call);

    for (const path of ['/auth/refresh', '/auth/logout']) {
      const response = await call(
        path,
        fromBrowser(refreshToken, 'https://evil.example'),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    }
    const auth = app.get<Auth<Claims>>(AUTH);
    expect(await auth.listSessions('u1')).toHaveLength(1);
  });

  it('logs out by revoking the session and clearing the cookie', async () => {
    const { app, call } = await start(GlobalGuardModule);
    const { refreshToken } = await login(call);

    const response = await call('/auth/logout', fromBrowser(refreshToken));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.getSetCookie()).toEqual([CLEARED]);
    expect(await app.get<Auth<Claims>>(AUTH).listSessions('u1')).toEqual([]);
  });

  it('fails loudly when @ToklynClaims() is used without the guard', async () => {
    const { call } = await start(GlobalGuardModule);

    expect((await call('/misconfigured')).status).toBe(500);
  });

  it('supports forRoot with a per-route guard', async () => {
    const { call } = await start(RouteGuardModule);
    const { accessToken } = await sharedAuth.createSession({ subject: 'u2' });

    const guarded = await call('/scoped/guarded', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const denied = await call('/scoped/guarded');
    const free = await call('/scoped/free');

    expect(await guarded.json()).toEqual({ sub: 'u2' });
    expect(denied.status).toBe(401);
    expect(free.status).toBe(200);
  });
});

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
