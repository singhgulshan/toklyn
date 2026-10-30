import { ToklynError } from '#src/errors.js';

const SECOND = 1000;
// RFC 6265 cookie-name (token) and cookie-octet grammars.
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const COOKIE_PATH = /^\/[\x21-\x3A\x3C-\x7E]*$/;
const DOMAIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const RESERVED_PREFIX = /^__(?:host|secure)-/i;
const SAME_SITE = new Set<string>(['Strict', 'Lax']);

export interface RefreshCookieOptions {
  /** Base name. `__Host-` or `__Secure-` is prepended when possible. Defaults to `toklyn_refresh`. */
  name?: string;
  /** Defaults to `/`. Scope it to your auth routes to send the cookie less often. */
  path?: string;
  /** Omit to keep the cookie host-only. */
  domain?: string;
  /** Defaults to true. Only disable for local development over plain HTTP. */
  secure?: boolean;
  /** Defaults to `Strict`. */
  sameSite?: 'Strict' | 'Lax';
}

export interface RefreshCookie {
  /** Final name, including any prefix. */
  readonly name: string;
  /** A `Set-Cookie` value that stores the token until `expiresAt` (epoch ms). */
  serialize(token: string, expiresAt: number, now: number): string;
  /** A `Set-Cookie` value that deletes the cookie. */
  serializeClear(): string;
}

export function createRefreshCookie(
  options: RefreshCookieOptions = {},
): RefreshCookie {
  const baseName = options.name ?? 'toklyn_refresh';
  const path = options.path ?? '/';
  const { domain } = options;
  const secure = options.secure ?? true;
  const sameSite = options.sameSite ?? 'Strict';

  if (!COOKIE_NAME.test(baseName) || RESERVED_PREFIX.test(baseName)) {
    throw invalidConfig('cookie name must be a plain token without a prefix');
  }
  if (!COOKIE_PATH.test(path)) {
    throw invalidConfig('cookie path must start with "/" and contain no ";"');
  }
  if (domain !== undefined && (domain.length > 253 || !DOMAIN.test(domain))) {
    throw invalidConfig('cookie domain must be a plain host name');
  }
  if (typeof secure !== 'boolean') {
    throw invalidConfig('cookie secure must be a boolean');
  }
  if (!SAME_SITE.has(sameSite)) {
    throw invalidConfig('cookie sameSite must be "Strict" or "Lax"');
  }

  const name = `${prefixFor(secure, path, domain)}${baseName}`;
  const attributes = [
    `Path=${path}`,
    ...(domain === undefined ? [] : [`Domain=${domain}`]),
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    `SameSite=${sameSite}`,
  ].join('; ');

  return {
    name,
    serialize(token, expiresAt, now) {
      if (!COOKIE_VALUE.test(token)) {
        throw new ToklynError('invalid_input', 'token is not a cookie value');
      }
      // Rounded down so the cookie never outlives the token.
      const maxAge = Math.max(0, Math.floor((expiresAt - now) / SECOND));
      return `${name}=${token}; Max-Age=${maxAge}; ${attributes}`;
    },
    serializeClear() {
      return `${name}=; Max-Age=0; ${attributes}`;
    },
  };
}

/**
 * Returns the cookie's value, or null if it is missing, empty, or present more than once
 * with different values (a sign of cookie tossing from a sibling domain).
 */
export function readCookie(
  header: string | null | undefined,
  name: string,
): string | null {
  if (typeof header !== 'string') return null;

  let found: string | null = null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;

    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (found !== null && found !== value) return null;
    found = value;
  }
  return found === '' ? null : found;
}

/** `__Host-` needs Secure, Path=/ and no Domain; `__Secure-` needs only Secure. */
function prefixFor(
  secure: boolean,
  path: string,
  domain: string | undefined,
): string {
  if (!secure) return '';
  return path === '/' && domain === undefined ? '__Host-' : '__Secure-';
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}
