import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { CustomDecorator, ExecutionContext } from '@nestjs/common';
import { TOKLYN_PUBLIC, claimsByRequest } from './internal.js';

/** Skips `ToklynAuthGuard` for a route or controller. */
export function ToklynPublic(): CustomDecorator<string> {
  return SetMetadata(TOKLYN_PUBLIC, true);
}

/** Injects the verified access-token claims. Throws if `ToklynAuthGuard` did not run. */
export const ToklynClaims = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const claims = claimsByRequest.get(context.switchToHttp().getRequest());
    if (!claims) {
      throw new Error('@ToklynClaims() needs ToklynAuthGuard on this route');
    }
    return claims;
  },
);
