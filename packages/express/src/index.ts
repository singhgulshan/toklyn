import type { Request, RequestHandler, Response } from 'express';
import type {
  AccessTokenClaims,
  Auth,
  ClaimsShape,
  CustomClaims,
  TokenPair,
} from 'toklyn';
import { createToklynHttp } from 'toklyn/http';
import type {
  OptionalAuthOptions,
  ToklynHttpOptions,
  ToklynHttpRequest,
  ToklynHttpResponse,
} from 'toklyn/http';

export type ToklynExpressOptions = ToklynHttpOptions;

export interface ToklynExpress {
  /** Rejects the request with 401 unless it carries a valid access token. */
  requireAuth: RequestHandler;
  /** Lets guests through; read the claims with `getOptionalAuth(req)`. */
  optionalAuth(options?: OptionalAuthOptions): RequestHandler;
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
