import type {
  AccessTokenClaims,
  Auth,
  ClaimsShape,
  CustomClaims,
  TokenPair,
} from 'toklyn';
import { createToklynHttp } from 'toklyn/http';
import type {
  ToklynHttpOptions,
  ToklynHttpRequest,
  ToklynHttpResponse,
} from 'toklyn/http';

export type ToklynNextOptions = ToklynHttpOptions;

export interface ToklynAuthContext<TClaims extends ClaimsShape = CustomClaims> {
  claims: AccessTokenClaims<TClaims>;
}

export type ToklynRouteHandler<
  TRequest extends Request,
  TContext extends object,
> = (request: TRequest, context: TContext) => Promise<Response>;

export interface ToklynNext<TClaims extends ClaimsShape = CustomClaims> {
  /** Export as `POST`. Rotates the refresh cookie and returns a new access token. */
  refresh(request: Request): Promise<Response>;
  /** Export as `POST`. Revokes the cookie's session and clears the cookie. */
  logout(request: Request): Promise<Response>;
  /** The login response for your own route, after `auth.createSession`. */
  sessionResponse(tokens: TokenPair): Response;
  /**
   * Wraps a route handler so it only runs with a valid Bearer token. The handler gets
   * the route context (e.g. `params`) plus `claims`.
   */
  withAuth<
    TRequest extends Request = Request,
    TContext extends object = object,
  >(
    handler: (
      request: TRequest,
      context: TContext & ToklynAuthContext<TClaims>,
    ) => Response | Promise<Response>,
  ): ToklynRouteHandler<TRequest, TContext>;
}

export function createToklynNext<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynNextOptions = {},
): ToklynNext<TClaims> {
  const http = createToklynHttp(auth, options);

  return {
    async refresh(request) {
      return toResponse(await http.refresh(toHttpRequest(request)));
    },
    async logout(request) {
      return toResponse(await http.logout(toHttpRequest(request)));
    },
    sessionResponse(tokens) {
      return toResponse(http.issue(tokens));
    },
    withAuth(handler) {
      return async (request, context) => {
        const result = await http.authenticate(toHttpRequest(request));
        if (!result.ok) return toResponse(result.response);
        return handler(request, { ...context, claims: result.claims });
      };
    },
  };
}

function toHttpRequest(request: Request): ToklynHttpRequest {
  return { header: (name) => request.headers.get(name) };
}

function toResponse(response: ToklynHttpResponse): Response {
  const headers = new Headers();
  for (const [name, value] of response.headers) headers.append(name, value);
  if (response.body === null) {
    return new Response(null, { status: response.status, headers });
  }
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers,
  });
}
