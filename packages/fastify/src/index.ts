import type {
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
  preHandlerAsyncHookHandler,
} from 'fastify';
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

export type ToklynFastifyOptions = ToklynHttpOptions;
export type ToklynFastifyResourceOptions = ToklynResourceOptions;

export interface ToklynFastifyGuards {
  /** `preHandler` hook. Answers 401 unless the request carries a valid access token. */
  requireAuth: preHandlerAsyncHookHandler;
  /** `preHandler` hook that lets guests through; read the claims with `getOptionalAuth(request)`. */
  optionalAuth(options?: OptionalAuthOptions): preHandlerAsyncHookHandler;
}

export interface ToklynFastify extends ToklynFastifyGuards {
  /** Route handler for POST. Rotates the refresh cookie and returns a new access token. */
  refreshHandler: RouteHandlerMethod;
  /** Route handler for POST. Revokes the cookie's session and clears the cookie. */
  logoutHandler: RouteHandlerMethod;
  /** Sends the login response from your own route, after `auth.createSession`. */
  sendSession(reply: FastifyReply, tokens: TokenPair): FastifyReply;
}

// Request-scoped storage instead of a global `FastifyRequest` augmentation. Null means guest.
const claimsByRequest = new WeakMap<FastifyRequest, AccessTokenClaims | null>();

export function createToklynFastify<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynFastifyOptions = {},
): ToklynFastify {
  const http = createToklynHttp(auth, options);

  return {
    ...guards(http),
    async refreshHandler(request, reply) {
      return send(reply, await http.refresh(toHttpRequest(request)));
    },
    async logoutHandler(request, reply) {
      return send(reply, await http.logout(toHttpRequest(request)));
    },
    sendSession(reply, tokens) {
      return send(reply, http.issue(tokens));
    },
  };
}

/**
 * Hooks for a service that only verifies tokens, e.g. with a
 * `RemoteJwksAccessTokenVerifier`. Bearer tokens only; `getAuth` works as usual.
 */
export function createToklynFastifyResource(
  verifier: AccessTokenVerifier,
  options: ToklynFastifyResourceOptions = {},
): ToklynFastifyGuards {
  return guards(createToklynResource(verifier, options));
}

/** Route handler for GET `/.well-known/jwks.json`. Build the set once with `createJwks`. */
export function jwksHandler(jwks: JsonWebKeySet): RouteHandlerMethod {
  const response = jwksResponse(jwks);
  return async (_request, reply) => send(reply, response);
}

/** Claims of the current request. Throws if `requireAuth` did not run before this handler. */
export function getAuth<TClaims extends ClaimsShape = CustomClaims>(
  request: FastifyRequest,
): AccessTokenClaims<TClaims> {
  const claims = claimsByRequest.get(request);
  if (claims === null) {
    throw new Error('getAuth() found a guest; use getOptionalAuth() here');
  }
  if (!claims) {
    throw new Error('getAuth() needs requireAuth to run first on this route');
  }
  return claims as AccessTokenClaims<TClaims>;
}

/** Claims of the current request, or null for a guest. Throws if no auth hook ran. */
export function getOptionalAuth<TClaims extends ClaimsShape = CustomClaims>(
  request: FastifyRequest,
): AccessTokenClaims<TClaims> | null {
  if (!claimsByRequest.has(request)) {
    throw new Error(
      'getOptionalAuth() needs optionalAuth or requireAuth to run first on this route',
    );
  }
  return (claimsByRequest.get(request) ??
    null) as AccessTokenClaims<TClaims> | null;
}

function guards<TClaims extends ClaimsShape>(
  http: ToklynAuthenticator<TClaims>,
): ToklynFastifyGuards {
  return {
    async requireAuth(request, reply) {
      const result = await http.authenticate(toHttpRequest(request));
      if (!result.ok) return send(reply, result.response);
      claimsByRequest.set(request, result.claims);
    },
    optionalAuth(optionalOptions) {
      return async (request, reply) => {
        const result = await http.authenticateOptional(
          toHttpRequest(request),
          optionalOptions,
        );
        if (!result.ok) return send(reply, result.response);
        claimsByRequest.set(request, result.claims);
      };
    },
  };
}

function toHttpRequest(request: FastifyRequest): ToklynHttpRequest {
  return {
    method: request.method,
    header(name) {
      const value = request.headers[name];
      // Repeated security headers are ambiguous, so treat them as absent.
      return typeof value === 'string' ? value : undefined;
    },
  };
}

function send(reply: FastifyReply, response: ToklynHttpResponse): FastifyReply {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of response.headers) {
    grouped.set(name, [...(grouped.get(name) ?? []), value]);
  }
  for (const [name, values] of grouped) {
    reply.header(name, values.length === 1 ? values[0] : values);
  }
  reply.code(response.status);
  // Returning the reply from an async hook or handler tells Fastify it was sent.
  return response.body === null ? reply.send() : reply.send(response.body);
}
