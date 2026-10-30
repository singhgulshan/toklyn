import type { Request, RequestHandler, Response } from 'express';
import type { AccessTokenClaims, Auth, CustomClaims, TokenPair } from 'toklyn';
import { createToklynHttp } from 'toklyn/http';
import type {
  ToklynHttpOptions,
  ToklynHttpRequest,
  ToklynHttpResponse,
} from 'toklyn/http';

export type ToklynExpressOptions = ToklynHttpOptions;

export interface ToklynExpress {
  /** Rejects the request with 401 unless it carries a valid Bearer token. */
  requireAuth: RequestHandler;
  /** Mount on POST. Rotates the refresh cookie and returns a new access token. */
  refreshHandler: RequestHandler;
  /** Mount on POST. Revokes the cookie's session and clears the cookie. */
  logoutHandler: RequestHandler;
  /** Sends the login response from your own route, after `auth.createSession`. */
  sendSession(res: Response, tokens: TokenPair): void;
}

// Request-scoped storage instead of a global `Request` type augmentation.
const claimsByRequest = new WeakMap<Request, AccessTokenClaims>();

export function createToklynExpress<
  TClaims extends CustomClaims = CustomClaims,
>(auth: Auth<TClaims>, options: ToklynExpressOptions = {}): ToklynExpress {
  const http = createToklynHttp(auth, options);

  return {
    async requireAuth(req, res, next) {
      const result = await http.authenticate(toHttpRequest(req));
      if (!result.ok) return send(res, result.response);
      claimsByRequest.set(req, result.claims);
      next();
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
export function getAuth<TClaims extends CustomClaims = CustomClaims>(
  req: Request,
): AccessTokenClaims<TClaims> {
  const claims = claimsByRequest.get(req);
  if (!claims) {
    throw new Error('getAuth() needs requireAuth to run first on this route');
  }
  return claims as AccessTokenClaims<TClaims>;
}

function toHttpRequest(req: Request): ToklynHttpRequest {
  return { header: (name) => req.get(name) };
}

function send(res: Response, response: ToklynHttpResponse): void {
  for (const [name, value] of response.headers) res.append(name, value);
  res.status(response.status);
  if (response.body === null) res.end();
  else res.json(response.body);
}
