import type { AccessTokenClaims } from 'toklyn';
import type { ToklynHttpRequest } from 'toklyn/http';

export const TOKLYN_HTTP = Symbol('toklyn:http');
export const TOKLYN_PUBLIC = 'toklyn:public';

// Request-scoped storage instead of a global request type augmentation.
export const claimsByRequest = new WeakMap<object, AccessTokenClaims>();

/** Both the Express and Fastify request objects expose Node's lower-case `headers`. */
export interface NodeStyleRequest {
  headers: Record<string, string | string[] | undefined>;
}

export function toHttpRequest(req: NodeStyleRequest): ToklynHttpRequest {
  return {
    header(name) {
      const value = req.headers[name];
      // Repeated security headers are ambiguous, so treat them as absent.
      return typeof value === 'string' ? value : undefined;
    },
  };
}
