import type { Auth } from '#src/auth.js';
import { systemClock } from '#src/clock.js';
import type { Clock } from '#src/contracts.js';
import type { JsonWebKeySet } from '#src/crypto/jwks.js';
import { ToklynError } from '#src/errors.js';
import type {
  AccessTokenClaims,
  ClaimsShape,
  CustomClaims,
  TokenPair,
} from '#src/types.js';
import { extractBearerToken } from './bearer.js';
import { createCookie, readCookie } from './cookies.js';
import type { CookieOptions, HttpCookie } from './cookies.js';
import { toToklynHttpError } from './errors.js';
import { isTrustedOrigin, toAllowedOrigins } from './origin.js';

/** The only thing the flows need from a request. Header names are lower case. */
export interface ToklynHttpRequest {
  /** In cookie mode, methods other than GET, HEAD and OPTIONS need a trusted origin. */
  method: string;
  header(name: string): string | null | undefined;
}

export type HttpHeaders = ReadonlyArray<readonly [name: string, value: string]>;

export interface CookieSessionResponseBody {
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  sessionId: string;
}

export interface SessionResponseBody extends CookieSessionResponseBody {
  accessToken: string;
}

export interface ErrorResponseBody {
  error: 'unauthorized' | 'forbidden' | 'service_unavailable';
}

/** A framework-neutral response. Adapters copy it onto their own response object. */
export interface ToklynHttpResponse {
  status: number;
  headers: HttpHeaders;
  /** Serialize as JSON. Null means no body. */
  body:
    | SessionResponseBody
    | CookieSessionResponseBody
    | ErrorResponseBody
    | JsonWebKeySet
    | null;
}

export type AuthenticateResult<TClaims extends ClaimsShape = CustomClaims> =
  | { ok: true; claims: AccessTokenClaims<TClaims> }
  | { ok: false; response: ToklynHttpResponse };

/** `claims` is null for guests. */
export type OptionalAuthenticateResult<
  TClaims extends ClaimsShape = CustomClaims,
> =
  | { ok: true; claims: AccessTokenClaims<TClaims> | null }
  | { ok: false; response: ToklynHttpResponse };

export interface OptionalAuthOptions {
  /**
   * What to do with an invalid or expired access token. `reject` (default) answers 401 so
   * the client can refresh; `ignore` treats the request as a guest.
   */
  invalidToken?: 'reject' | 'ignore';
}

export type ResolveResult<TClaims extends ClaimsShape = CustomClaims> = (
  | { status: 'authenticated'; claims: AccessTokenClaims<TClaims> }
  | { status: 'unauthenticated' | 'unavailable' }
) & {
  /** Add these to the response, e.g. the rotated cookies. */
  headers: HttpHeaders;
  /** The `Cookie` header to forward to the app so it sees rotated tokens. Null means none. */
  cookie: string | null;
};

export type AccessTokenTransport = 'bearer' | 'cookie';

export interface ToklynHttpOptions {
  /**
   * `bearer` (default): the access token is in the JSON body and sent back as
   * `Authorization: Bearer`. `cookie`: it is in an HttpOnly cookie, so server-rendered
   * pages can read it. Cookie mode needs `reuseGraceMs` > 0 on `auth`.
   */
  accessToken?: AccessTokenTransport;
  /** Refresh token cookie. Defaults: name `toklyn_refresh`, SameSite `Strict` (`Lax` in cookie mode). */
  cookie?: CookieOptions;
  /** Access token cookie, cookie mode only. Defaults: name `toklyn_access`, SameSite `Lax`. */
  accessCookie?: CookieOptions;
  /**
   * Origins trusted for cookie-authenticated writes, e.g. `https://app.example.com`.
   * Same-origin browser requests are always trusted. Required for SameSite `None`.
   */
  allowedOrigins?: readonly string[];
  /** Used for the cookies' Max-Age. Defaults to the system clock. */
  clock?: Clock;
}

/** What route guards need: works with a full `ToklynHttp` or a verify-only `ToklynResource`. */
export interface ToklynAuthenticator<
  TClaims extends ClaimsShape = CustomClaims,
> {
  /**
   * Verifies the Bearer token, or the access cookie in cookie mode. Storage errors in
   * `online` mode give a 503.
   */
  authenticate(
    request: ToklynHttpRequest,
  ): Promise<AuthenticateResult<TClaims>>;
  /**
   * Like `authenticate`, but a request without an access token is a guest (`claims: null`).
   * In cookie mode, untrusted cross-site writes are guests too. Storage errors still give a 503.
   */
  authenticateOptional(
    request: ToklynHttpRequest,
    options?: OptionalAuthOptions,
  ): Promise<OptionalAuthenticateResult<TClaims>>;
}

export interface ToklynHttp<
  TClaims extends ClaimsShape = CustomClaims,
> extends ToklynAuthenticator<TClaims> {
  readonly accessToken: AccessTokenTransport;
  readonly cookieName: string;
  /** Null in bearer mode. */
  readonly accessCookieName: string | null;
  /** Response for your own login route, after `auth.createSession`. */
  issue(tokens: TokenPair): ToklynHttpResponse;
  refresh(request: ToklynHttpRequest): Promise<ToklynHttpResponse>;
  /** Revokes the cookie's session and clears the cookies. */
  logout(request: ToklynHttpRequest): Promise<ToklynHttpResponse>;
  /**
   * Cookie mode, for middleware in front of server-rendered pages: verifies the access
   * cookie and refreshes it when needed. Untrusted cross-site writes are treated as
   * signed out, and their auth cookies are not forwarded.
   */
  resolve(request: ToklynHttpRequest): Promise<ResolveResult<TClaims>>;
  /**
   * Cookie mode: claims from the access cookie in a `Cookie` header, or null. Never
   * refreshes and does no origin check. Throws on storage errors.
   */
  readClaims(
    cookieHeader: string | null | undefined,
  ): Promise<AccessTokenClaims<TClaims> | null>;
}

const NO_STORE: readonly [string, string] = ['Cache-Control', 'no-store'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createToklynHttp<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynHttpOptions = {},
): ToklynHttp<TClaims> {
  const mode = options.accessToken ?? 'bearer';
  if (mode !== 'bearer' && mode !== 'cookie') {
    throw invalidConfig('accessToken must be "bearer" or "cookie"');
  }
  const cookieMode = mode === 'cookie';
  if (!cookieMode && options.accessCookie !== undefined) {
    throw invalidConfig('accessCookie needs accessToken "cookie"');
  }
  if (cookieMode && !(auth.reuseGraceMs > 0)) {
    // Parallel page requests refresh with the same token; strict reuse detection would revoke the session.
    throw invalidConfig('accessToken "cookie" needs reuseGraceMs > 0 on auth');
  }

  const refreshCookie = createCookie(
    { name: 'toklyn_refresh', sameSite: cookieMode ? 'Lax' : 'Strict' },
    options.cookie,
  );
  const accessCookie = cookieMode
    ? createCookie(
        { name: 'toklyn_access', sameSite: 'Lax' },
        options.accessCookie,
      )
    : null;
  if (accessCookie?.name === refreshCookie.name) {
    throw invalidConfig('access and refresh cookies need different names');
  }
  const allowedOrigins = toAllowedOrigins(options.allowedOrigins);
  const allCookies = accessCookie
    ? [refreshCookie, accessCookie]
    : [refreshCookie];
  if (
    allCookies.some((cookie) => cookie.sameSite === 'None') &&
    allowedOrigins.size === 0
  ) {
    throw invalidConfig('cookie sameSite "None" needs allowedOrigins');
  }
  const clock = options.clock ?? systemClock;

  const cookieNames = allCookies.map((cookie) => cookie.name);
  const clearCookies: HttpHeaders = allCookies.map((cookie) => [
    'Set-Cookie',
    cookie.serializeClear(),
  ]);

  function sessionCookies(tokens: TokenPair): HttpHeaders {
    const now = clock.now();
    const headers: [string, string][] = [
      [
        'Set-Cookie',
        refreshCookie.serialize(
          tokens.refreshToken,
          tokens.refreshTokenExpiresAt,
          now,
        ),
      ],
    ];
    if (accessCookie) {
      headers.push([
        'Set-Cookie',
        accessCookie.serialize(
          tokens.accessToken,
          tokens.accessTokenExpiresAt,
          now,
        ),
      ]);
    }
    return headers;
  }

  function issue(tokens: TokenPair): ToklynHttpResponse {
    const body: CookieSessionResponseBody = {
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      sessionId: tokens.sessionId,
    };
    return {
      status: 200,
      headers: [...sessionCookies(tokens), NO_STORE],
      body: accessCookie ? body : { accessToken: tokens.accessToken, ...body },
    };
  }

  function isTrusted(request: ToklynHttpRequest): boolean {
    return isTrustedOrigin(
      {
        origin: request.header('origin'),
        secFetchSite: request.header('sec-fetch-site'),
      },
      allowedOrigins,
    );
  }

  function isTrustedWrite(request: ToklynHttpRequest): boolean {
    return SAFE_METHODS.has(request.method.toUpperCase()) || isTrusted(request);
  }

  async function verify(
    token: string,
  ): Promise<AccessTokenClaims<TClaims> | 401 | 503> {
    try {
      return await auth.verifyAccessToken(token);
    } catch (error) {
      const mapped = toToklynHttpError(error);
      if (!mapped) throw error;
      return mapped.status;
    }
  }

  function authFailure(status: 401 | 503): ToklynHttpResponse {
    if (status === 503) return failure(503, []);
    return failure(401, accessCookie ? [] : [['WWW-Authenticate', 'Bearer']]);
  }

  function requireAccessCookie(method: string): HttpCookie {
    if (!accessCookie) {
      throw invalidConfig(`${method}() needs accessToken "cookie"`);
    }
    return accessCookie;
  }

  function readAccessToken(request: ToklynHttpRequest): string | null {
    return accessCookie
      ? readCookie(request.header('cookie'), accessCookie.name)
      : extractBearerToken(request.header('authorization'));
  }

  return {
    accessToken: mode,
    cookieName: refreshCookie.name,
    accessCookieName: accessCookie?.name ?? null,
    issue,

    async authenticate(request) {
      if (accessCookie && !isTrustedWrite(request)) {
        return { ok: false, response: forbidden() };
      }
      const token = readAccessToken(request);
      if (token === null) return { ok: false, response: authFailure(401) };

      const result = await verify(token);
      if (typeof result === 'number') {
        return { ok: false, response: authFailure(result) };
      }
      return { ok: true, claims: result };
    },

    async authenticateOptional(request, optionalOptions = {}) {
      const invalidToken = optionalOptions.invalidToken ?? 'reject';
      if (invalidToken !== 'reject' && invalidToken !== 'ignore') {
        throw invalidConfig('invalidToken must be "reject" or "ignore"');
      }
      if (accessCookie && !isTrustedWrite(request)) {
        return { ok: true, claims: null };
      }
      const token = readAccessToken(request);
      if (token === null) return { ok: true, claims: null };

      const result = await verify(token);
      if (result === 401 && invalidToken === 'ignore') {
        return { ok: true, claims: null };
      }
      if (typeof result === 'number') {
        return { ok: false, response: authFailure(result) };
      }
      return { ok: true, claims: result };
    },

    async refresh(request) {
      if (!isTrusted(request)) return forbidden();

      const refreshToken = readCookie(
        request.header('cookie'),
        refreshCookie.name,
      );
      if (refreshToken === null) return failure(401, clearCookies);
      try {
        return issue(await auth.refresh({ refreshToken }));
      } catch (error) {
        const mapped = toToklynHttpError(error);
        if (!mapped) throw error;
        // Keep the cookies on 503: the token may still be valid once storage recovers.
        return failure(
          mapped.status,
          mapped.status === 401 ? clearCookies : [],
        );
      }
    },

    async logout(request) {
      if (!isTrusted(request)) return forbidden();

      const refreshToken = readCookie(
        request.header('cookie'),
        refreshCookie.name,
      );
      if (refreshToken !== null) {
        try {
          await auth.logout(refreshToken);
        } catch (error) {
          const mapped = toToklynHttpError(error);
          if (!mapped) throw error;
          if (mapped.status === 503) return failure(503, clearCookies);
        }
      }
      return { status: 204, headers: [...clearCookies, NO_STORE], body: null };
    },

    async resolve(request) {
      const access = requireAccessCookie('resolve');
      const header = request.header('cookie') ?? null;
      const signedOut = (headers: HttpHeaders): ResolveResult<TClaims> => ({
        status: 'unauthenticated',
        headers,
        cookie: rewriteCookieHeader(header, cookieNames, []),
      });

      if (!isTrustedWrite(request)) return signedOut([]);

      const accessToken = readCookie(header, access.name);
      if (accessToken !== null) {
        const result = await verify(accessToken);
        if (result === 503) {
          return { status: 'unavailable', headers: [NO_STORE], cookie: header };
        }
        if (result !== 401) {
          return {
            status: 'authenticated',
            claims: result,
            headers: [],
            cookie: header,
          };
        }
      }

      const refreshToken = readCookie(header, refreshCookie.name);
      if (refreshToken === null) {
        return signedOut(
          accessToken === null ? [] : [...clearCookies, NO_STORE],
        );
      }

      let tokens: TokenPair;
      try {
        tokens = await auth.refresh({ refreshToken });
      } catch (error) {
        const mapped = toToklynHttpError(error);
        if (!mapped) throw error;
        if (mapped.status === 503) {
          return { status: 'unavailable', headers: [NO_STORE], cookie: header };
        }
        return signedOut([...clearCookies, NO_STORE]);
      }

      // The old refresh token is spent, so the new cookies must be sent whatever happens next.
      const headers = [...sessionCookies(tokens), NO_STORE];
      const cookie = rewriteCookieHeader(header, cookieNames, [
        [refreshCookie.name, tokens.refreshToken],
        [access.name, tokens.accessToken],
      ]);
      const claims = await verify(tokens.accessToken);
      if (typeof claims === 'number') {
        return {
          status: claims === 503 ? 'unavailable' : 'unauthenticated',
          headers,
          cookie,
        };
      }
      return { status: 'authenticated', claims, headers, cookie };
    },

    async readClaims(cookieHeader) {
      const access = requireAccessCookie('readClaims');
      const token = readCookie(cookieHeader, access.name);
      if (token === null) return null;
      const result = await verify(token);
      if (result === 401) return null;
      if (result === 503) {
        throw new ToklynError(
          'storage_error',
          'could not verify the access token',
        );
      }
      return result;
    },
  };
}

/** Drops the named cookies from a `Cookie` header and appends replacements. */
function rewriteCookieHeader(
  header: string | null,
  remove: readonly string[],
  add: ReadonlyArray<readonly [name: string, value: string]>,
): string | null {
  const kept = (header ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair === '') return false;
      const eq = pair.indexOf('=');
      const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      return !remove.includes(name);
    });
  const pairs = [...kept, ...add.map(([name, value]) => `${name}=${value}`)];
  return pairs.length === 0 ? null : pairs.join('; ');
}

function forbidden(): ToklynHttpResponse {
  return { status: 403, headers: [NO_STORE], body: { error: 'forbidden' } };
}

function failure(status: 401 | 503, headers: HttpHeaders): ToklynHttpResponse {
  return {
    status,
    headers: [...headers, NO_STORE],
    body: { error: status === 401 ? 'unauthorized' : 'service_unavailable' },
  };
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}
