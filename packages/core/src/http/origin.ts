import { ToklynError } from '#src/errors.js';

export interface OriginHeaders {
  origin?: string | null | undefined;
  secFetchSite?: string | null | undefined;
}

/**
 * CSRF check for cookie-authenticated requests. Trusts a browser-set
 * `Sec-Fetch-Site: same-origin`, or an `Origin` on the allow-list. Anything else is rejected,
 * including requests that carry neither header.
 */
export function isTrustedOrigin(
  headers: OriginHeaders,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (headers.secFetchSite === 'same-origin') return true;
  return (
    typeof headers.origin === 'string' && allowedOrigins.has(headers.origin)
  );
}

/** Validates entries such as `https://app.example.com` (scheme, host, optional port; no path). */
export function toAllowedOrigins(
  origins: readonly string[] = [],
): ReadonlySet<string> {
  for (const origin of origins) {
    if (!isSerializedOrigin(origin)) {
      throw new ToklynError(
        'invalid_config',
        `allowedOrigins entry "${String(origin)}" is not an http(s) origin`,
      );
    }
  }
  return new Set(origins);
}

function isSerializedOrigin(value: unknown): boolean {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.origin === value
  );
}
