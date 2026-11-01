import type {
  AccessTokenClaims,
  ClaimsShape,
  CustomClaims,
  TokenPair,
} from 'toklyn';
import type {
  HttpHeaders,
  OptionalAuthOptions,
  ToklynAuthenticator,
  ToklynHttp,
  ToklynHttpRequest,
  ToklynHttpResponse,
} from 'toklyn/http';

export interface ToklynAuthContext<TClaims extends ClaimsShape = CustomClaims> {
  claims: AccessTokenClaims<TClaims>;
}

export interface ToklynOptionalAuthContext<
  TClaims extends ClaimsShape = CustomClaims,
> {
  /** Null for guests. */
  claims: AccessTokenClaims<TClaims> | null;
}

export type ToklynRouteHandler<
  TRequest extends Request,
  TContext extends object,
> = (request: TRequest, context: TContext) => Promise<Response>;

export interface ToklynNextGuards<TClaims extends ClaimsShape = CustomClaims> {
  /**
   * Wraps a route handler so it only runs with a valid access token. The handler gets
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
  /** Like `withAuth`, but guests get through with `claims: null`. */
  withOptionalAuth<
    TRequest extends Request = Request,
    TContext extends object = object,
  >(
    handler: (
      request: TRequest,
      context: TContext & ToklynOptionalAuthContext<TClaims>,
    ) => Response | Promise<Response>,
    options?: OptionalAuthOptions,
  ): ToklynRouteHandler<TRequest, TContext>;
}

export interface ToklynNext<
  TClaims extends ClaimsShape = CustomClaims,
> extends ToklynNextGuards<TClaims> {
  /** Export as `POST`. Rotates the refresh cookie and returns a new session. */
  refresh(request: Request): Promise<Response>;
  /** Export as `POST`. Revokes the cookie's session and clears the cookies. */
  logout(request: Request): Promise<Response>;
  /** The login response for your own route, after `auth.createSession`. */
  sessionResponse(tokens: TokenPair): Response;
}

export function routeHandlers<TClaims extends ClaimsShape>(
  http: ToklynHttp<TClaims>,
): ToklynNext<TClaims> {
  return {
    ...guards(http),
    async refresh(request) {
      return toResponse(await http.refresh(toHttpRequest(request)));
    },
    async logout(request) {
      return toResponse(await http.logout(toHttpRequest(request)));
    },
    sessionResponse(tokens) {
      return toResponse(http.issue(tokens));
    },
  };
}

export function guards<TClaims extends ClaimsShape>(
  http: ToklynAuthenticator<TClaims>,
): ToklynNextGuards<TClaims> {
  return {
    withAuth(handler) {
      return async (request, context) => {
        const result = await http.authenticate(toHttpRequest(request));
        if (!result.ok) return toResponse(result.response);
        return handler(request, { ...context, claims: result.claims });
      };
    },
    withOptionalAuth(handler, options) {
      return async (request, context) => {
        const result = await http.authenticateOptional(
          toHttpRequest(request),
          options,
        );
        if (!result.ok) return toResponse(result.response);
        return handler(request, { ...context, claims: result.claims });
      };
    },
  };
}

export function toHttpRequest(request: Request): ToklynHttpRequest {
  return {
    method: request.method,
    header: (name) => request.headers.get(name),
  };
}

export function appendHeaders<T extends Response>(
  response: T,
  headers: HttpHeaders,
): T {
  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

export function toResponse(response: ToklynHttpResponse): Response {
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
