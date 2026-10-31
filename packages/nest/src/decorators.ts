import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { CustomDecorator, ExecutionContext } from '@nestjs/common';
import type { OptionalAuthOptions } from 'toklyn/http';
import { TOKLYN_OPTIONAL, TOKLYN_PUBLIC, claimsByRequest } from './internal.js';

/** Skips `ToklynAuthGuard` for a route or controller. */
export function ToklynPublic(): CustomDecorator<string> {
  return SetMetadata(TOKLYN_PUBLIC, true);
}

/**
 * Lets guests through `ToklynAuthGuard`; `@ToklynClaims()` is then null for them.
 * `@ToklynPublic()` takes precedence.
 */
export function ToklynOptional(
  options: OptionalAuthOptions = {},
): CustomDecorator<string> {
  return SetMetadata(TOKLYN_OPTIONAL, options);
}

/**
 * Injects the verified access-token claims, or null for a guest on a `@ToklynOptional()`
 * route. Throws if `ToklynAuthGuard` did not run.
 */
export const ToklynClaims = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const req = context.switchToHttp().getRequest<object>();
    if (!claimsByRequest.has(req)) {
      throw new Error('@ToklynClaims() needs ToklynAuthGuard on this route');
    }
    return claimsByRequest.get(req) ?? null;
  },
);
