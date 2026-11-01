import type { Request, RequestHandler, Response } from 'express';
import type {
  AccessTokenClaims,
  AccessTokenVerifier,
  Auth,
  ClaimsShape,
  CustomClaims,
  JsonWebKeySet,
  TokenPair,
} from 'toklyn';
import {
  createToklynHttp,
  createToklynResource,
  jwksResponse,
} from 'toklyn/http';
import type {
  OptionalAuthOptions,
  ToklynAuthenticator,
  ToklynHttpOptions,
  ToklynHttpRequest,
  ToklynHttpResponse,
  ToklynResourceOptions,
} from 'toklyn/http';

export type ToklynExpressOptions = ToklynHttpOptions;
export type ToklynExpressResourceOptions = ToklynResourceOptions;

export interface ToklynExpressGuards {
  /** Rejects the request with 401 unless it carries a valid access token. */
  requireAuth: RequestHandler;
  /** Lets guests through; read the claims with `getOptionalAuth(req)`. */
  optionalAuth(options?: OptionalAuthOptions): RequestHandler;
}

export interface ToklynExpress extends ToklynExpressGuards {
  /** Mount on POST. Rotates the refresh cookie and returns a new access token. */
  refreshHandler: RequestHandler;
  /** Mount on POST. Revokes the cookie's session and clears the cookie. */
  logoutHandler: RequestHandler;
  /** Sends the login response from your own route, after `auth.createSession`. */
  sendSession(res: Response, tokens: TokenPair): void;
}

// Request-scoped storage instead of a global `Request` type augmentation. Null means guest.
const claimsByRequest = new WeakMap<Request, AccessTokenClaims | null>();

export function createToklynExpress<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynExpressOptions = {},
): ToklynExpress {
  const http = createToklynHttp(auth, options);

  return {
    ...guards(http),
    async refreshHandler(req, res) {
      send(res, await http.refresh(toHttpRequest(req)));
    },
    async logoutHandler(req, res) {
      send(res, await http.logout(toHttpRequest(req)));
    },
    sendSession(res, tokens) {
      send(res, http.issue(tokens));
    },
  };
}

/**
 * Guards for a service that only verifies tokens, e.g. with a
 * `RemoteJwksAccessTokenVerifier`. Bearer tokens only; `getAuth` works as usual.
 */
export function createToklynExpressResource(
  verifier: AccessTokenVerifier,
  options: ToklynExpressResourceOptions = {},
): ToklynExpressGuards {
  return guards(createToklynResource(verifier, options));
}

/** Mount on GET `/.well-known/jwks.json`. Build the set once with `createJwks`. */
export function jwksHandler(jwks: JsonWebKeySet): RequestHandler {
  const response = jwksResponse(jwks);
  return (_req, res) => send(res, response);
}

function guards<TClaims extends ClaimsShape>(
  http: ToklynAuthenticator<TClaims>,
): ToklynExpressGuards {
  return {
    async requireAuth(req, res, next) {
      const result = await http.authenticate(toHttpRequest(req));
      if (!result.ok) return send(res, result.response);
      claimsByRequest.set(req, result.claims);
      next();
    },
    optionalAuth(optionalOptions) {
      return async (req, res, next) => {
        const result = await http.authenticateOptional(
          toHttpRequest(req),
          optionalOptions,
        );
        if (!result.ok) return send(res, result.response);
        claimsByRequest.set(req, result.claims);
        next();
      };
    },
  };
}

/** Claims of the current request. Throws if `requireAuth` did not run before this handler. */
export function getAuth<TClaims extends ClaimsShape = CustomClaims>(
  req: Request,
): AccessTokenClaims<TClaims> {
  const claims = claimsByRequest.get(req);
  if (claims === null) {
    throw new Error('getAuth() found a guest; use getOptionalAuth() here');
  }
  if (!claims) {
    throw new Error('getAuth() needs requireAuth to run first on this route');
  }
  return claims as AccessTokenClaims<TClaims>;
}

/** Claims of the current request, or null for a guest. Throws if no auth middleware ran. */
export function getOptionalAuth<TClaims extends ClaimsShape = CustomClaims>(
  req: Request,
): AccessTokenClaims<TClaims> | null {
  if (!claimsByRequest.has(req)) {
    throw new Error(
      'getOptionalAuth() needs optionalAuth or requireAuth to run first on this route',
    );
  }
  return (claimsByRequest.get(req) ??
    null) as AccessTokenClaims<TClaims> | null;
}

function toHttpRequest(req: Request): ToklynHttpRequest {
  return { method: req.method, header: (name) => req.get(name) };
}

function send(res: Response, response: ToklynHttpResponse): void {
  for (const [name, value] of response.headers) res.append(name, value);
  res.status(response.status);
  if (response.body === null) res.end();
  else res.json(response.body);
}
