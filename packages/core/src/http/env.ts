import { readList, readOptional, resolveEnv } from '#src/env.js';
import type { FromEnvOptions } from '#src/env.js';
import type { ToklynHttpOptions } from './http-auth.js';

/**
 * Adds `TOKLYN_ALLOWED_ORIGINS` (comma-separated) and `TOKLYN_COOKIE_DOMAIN` to the options.
 * Values set in `options` win. Setting a domain changes the cookie prefix from `__Host-` to
 * `__Secure-`.
 */
export function httpOptionsFromEnv<T extends ToklynHttpOptions>(
  options: T = {} as T,
  from: FromEnvOptions = {},
): T & Pick<ToklynHttpOptions, 'allowedOrigins' | 'cookie' | 'accessCookie'> {
  const env = resolveEnv(from.env);
  const origins = readList(env, 'TOKLYN_ALLOWED_ORIGINS');
  const domain = readOptional(env, 'TOKLYN_COOKIE_DOMAIN');

  const extra: ToklynHttpOptions = {};
  if (options.allowedOrigins === undefined && origins.length > 0) {
    extra.allowedOrigins = origins;
  }
  if (domain !== undefined) {
    if (options.cookie?.domain === undefined) {
      extra.cookie = { ...options.cookie, domain };
    }
    if (
      options.accessToken === 'cookie' &&
      options.accessCookie?.domain === undefined
    ) {
      extra.accessCookie = { ...options.accessCookie, domain };
    }
  }
  return { ...options, ...extra };
}
