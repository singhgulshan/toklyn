import type { HttpAdapterHost } from '@nestjs/core';
import type { AccessTokenClaims } from 'toklyn';
import type { HttpHeaders, ToklynHttpRequest } from 'toklyn/http';

export const TOKLYN_HTTP = Symbol('toklyn:http');
export const TOKLYN_PUBLIC = 'toklyn:public';
export const TOKLYN_OPTIONAL = 'toklyn:optional';

// Request-scoped storage instead of a global request type augmentation. Null means guest.
export const claimsByRequest = new WeakMap<object, AccessTokenClaims | null>();

/** Both the Express and Fastify request objects expose `method` and Node's lower-case `headers`. */
export interface NodeStyleRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

export function toHttpRequest(req: NodeStyleRequest): ToklynHttpRequest {
  return {
    method: req.method,
    header(name) {
      const value = req.headers[name];
      // Repeated security headers are ambiguous, so treat them as absent.
      return typeof value === 'string' ? value : undefined;
    },
  };
}

export function writeHeaders(
  adapter: HttpAdapterHost['httpAdapter'],
  res: object,
  headers: HttpHeaders,
): void {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of headers) {
    grouped.set(name, [...(grouped.get(name) ?? []), value]);
  }
  for (const [name, values] of grouped) {
    // setHeader replaces; Express and Fastify both write one line per array entry.
    adapter.setHeader(
      res,
      name,
      (values.length === 1 ? values[0] : values) as string,
    );
  }
}
