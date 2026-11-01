import type {
  AccessTokenVerifier,
  Auth,
  ClaimsShape,
  CustomClaims,
  JsonWebKeySet,
} from 'toklyn';
import {
  createToklynHttp,
  createToklynResource,
  jwksResponse,
} from 'toklyn/http';
import type { ToklynHttpOptions, ToklynResourceOptions } from 'toklyn/http';
import { guards, routeHandlers, toResponse } from './internal.js';
import type { ToklynNext, ToklynNextGuards } from './internal.js';

export type {
  ToklynAuthContext,
  ToklynNext,
  ToklynNextGuards,
  ToklynOptionalAuthContext,
  ToklynRouteHandler,
} from './internal.js';

export type ToklynNextOptions = ToklynHttpOptions;
export type ToklynNextResourceOptions = ToklynResourceOptions;

export function createToklynNext<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynNextOptions = {},
): ToklynNext<TClaims> {
  return routeHandlers(createToklynHttp(auth, options));
}

/**
 * `withAuth` and `withOptionalAuth` for a service that only verifies tokens, e.g. with a
 * `RemoteJwksAccessTokenVerifier`. Bearer tokens only.
 */
export function createToklynNextResource<
  TClaims extends ClaimsShape = CustomClaims,
>(
  verifier: AccessTokenVerifier,
  options: ToklynNextResourceOptions = {},
): ToklynNextGuards<TClaims> {
  return guards(createToklynResource<TClaims>(verifier, options));
}

/** Export as `GET` from `app/.well-known/jwks.json/route.ts`. Build the set with `createJwks`. */
export function jwksRoute(jwks: JsonWebKeySet): () => Response {
  const response = jwksResponse(jwks);
  return () => toResponse(response);
}
