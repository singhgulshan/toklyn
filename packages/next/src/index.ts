import type { Auth, ClaimsShape, CustomClaims } from 'toklyn';
import { createToklynHttp } from 'toklyn/http';
import type { ToklynHttpOptions } from 'toklyn/http';
import { routeHandlers } from './internal.js';
import type { ToklynNext } from './internal.js';

export type {
  ToklynAuthContext,
  ToklynNext,
  ToklynOptionalAuthContext,
  ToklynRouteHandler,
} from './internal.js';

export type ToklynNextOptions = ToklynHttpOptions;

export function createToklynNext<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynNextOptions = {},
): ToklynNext<TClaims> {
  return routeHandlers(createToklynHttp(auth, options));
}
