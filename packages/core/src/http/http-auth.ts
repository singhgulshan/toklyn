import type { Auth } from '#src/auth.js';
import { systemClock } from '#src/clock.js';
import type { Clock } from '#src/contracts.js';
import type {
  AccessTokenClaims,
  ClaimsShape,
  CustomClaims,
  TokenPair,
} from '#src/types.js';
import { extractBearerToken } from './bearer.js';
import { createRefreshCookie, readCookie } from './cookies.js';
import type { RefreshCookieOptions } from './cookies.js';
import { toToklynHttpError } from './errors.js';
import { isTrustedOrigin, toAllowedOrigins } from './origin.js';

/** The only thing the flows need from a request. Header names are lower case. */
export interface ToklynHttpRequest {
  header(name: string): string | null | undefined;
}

export interface SessionResponseBody {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  sessionId: string;
}

export interface ErrorResponseBody {
  error: 'unauthorized' | 'forbidden' | 'service_unavailable';
}

/** A framework-neutral response. Adapters copy it onto their own response object. */
export interface ToklynHttpResponse {
  status: number;
  headers: ReadonlyArray<readonly [name: string, value: string]>;
  /** Serialize as JSON. Null means no body. */
  body: SessionResponseBody | ErrorResponseBody | null;
}

export type AuthenticateResult<TClaims extends ClaimsShape = CustomClaims> =
  | { ok: true; claims: AccessTokenClaims<TClaims> }
  | { ok: false; response: ToklynHttpResponse };

export interface ToklynHttpOptions {
  cookie?: RefreshCookieOptions;
  /**
   * Origins allowed to call refresh and logout, e.g. `https://app.example.com`.
   * Same-origin browser requests are always allowed.
   */
  allowedOrigins?: readonly string[];
  /** Used for the cookie's Max-Age. Defaults to the system clock. */
  clock?: Clock;
}

/**
 * Refresh token in an HttpOnly cookie; access token in the JSON body, sent back as
 * `Authorization: Bearer`.
 */
export interface ToklynHttp<TClaims extends ClaimsShape = CustomClaims> {
  readonly cookieName: string;
  /** Verifies the Bearer token. Storage errors in `online` mode give a 503. */
  authenticate(
    request: ToklynHttpRequest,
  ): Promise<AuthenticateResult<TClaims>>;
  /** Response for your own login route, after `auth.createSession`. */
  issue(tokens: TokenPair): ToklynHttpResponse;
  refresh(request: ToklynHttpRequest): Promise<ToklynHttpResponse>;
  /** Revokes the cookie's session and clears the cookie. */
  logout(request: ToklynHttpRequest): Promise<ToklynHttpResponse>;
}

const NO_STORE: readonly [string, string] = ['Cache-Control', 'no-store'];

export function createToklynHttp<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynHttpOptions = {},
): ToklynHttp<TClaims> {
  const cookie = createRefreshCookie(options.cookie);
  const allowedOrigins = toAllowedOrigins(options.allowedOrigins);
  const clock = options.clock ?? systemClock;

  const clearCookie: readonly [string, string] = [
    'Set-Cookie',
    cookie.serializeClear(),
  ];

  function issue(tokens: TokenPair): ToklynHttpResponse {
    const setCookie = cookie.serialize(
      tokens.refreshToken,
      tokens.refreshTokenExpiresAt,
      clock.now(),
    );
    return {
      status: 200,
      headers: [['Set-Cookie', setCookie], NO_STORE],
      body: {
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        sessionId: tokens.sessionId,
      },
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

  return {
    cookieName: cookie.name,
    issue,

    async authenticate(request) {
      const token = extractBearerToken(request.header('authorization'));
      if (token === null) {
        return { ok: false, response: bearerFailure(401) };
      }
      try {
        return { ok: true, claims: await auth.verifyAccessToken(token) };
      } catch (error) {
        const mapped = toToklynHttpError(error);
        if (!mapped) throw error;
        return { ok: false, response: bearerFailure(mapped.status) };
      }
    },

    async refresh(request) {
      if (!isTrusted(request)) return forbidden();

      const refreshToken = readCookie(request.header('cookie'), cookie.name);
      if (refreshToken === null) return failure(401, [clearCookie]);
      try {
        return issue(await auth.refresh({ refreshToken }));
      } catch (error) {
        const mapped = toToklynHttpError(error);
        if (!mapped) throw error;
        // Keep the cookie on 503: the token may still be valid once storage recovers.
        return failure(
          mapped.status,
          mapped.status === 401 ? [clearCookie] : [],
        );
      }
    },

    async logout(request) {
      if (!isTrusted(request)) return forbidden();

      const refreshToken = readCookie(request.header('cookie'), cookie.name);
      if (refreshToken !== null) {
        try {
          // The store can only look a session up by id, so rotating is how we learn it.
          const { sessionId } = await auth.refresh({ refreshToken });
          await auth.revokeSession(sessionId);
        } catch (error) {
          const mapped = toToklynHttpError(error);
          if (!mapped) throw error;
          if (mapped.status === 503) return failure(503, [clearCookie]);
        }
      }
      return { status: 204, headers: [clearCookie, NO_STORE], body: null };
    },
  };
}

function bearerFailure(status: 401 | 503): ToklynHttpResponse {
  return status === 401
    ? failure(401, [['WWW-Authenticate', 'Bearer']])
    : failure(503, []);
}

function forbidden(): ToklynHttpResponse {
  return { status: 403, headers: [NO_STORE], body: { error: 'forbidden' } };
}

function failure(
  status: 401 | 503,
  headers: ReadonlyArray<readonly [string, string]>,
): ToklynHttpResponse {
  return {
    status,
    headers: [...headers, NO_STORE],
    body: { error: status === 401 ? 'unauthorized' : 'service_unavailable' },
  };
}
