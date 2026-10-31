// Extensionless on purpose: Next aliases these specifiers to its bundled runtime.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ToklynError } from 'toklyn';
import type {
  AccessTokenClaims,
  Auth,
  ClaimsShape,
  CustomClaims,
} from 'toklyn';
import { createToklynHttp } from 'toklyn/http';
import type { ToklynHttpOptions } from 'toklyn/http';
import { appendHeaders, routeHandlers, toHttpRequest } from './internal.js';
import type { ToklynNext } from './internal.js';

export interface ToklynServerOptions extends Omit<
  ToklynHttpOptions,
  'accessToken'
> {
  /** Signed-out page visits go here, with the original path in `?from=`. */
  loginPath: string;
  /** Pages the proxy shows to signed-out visitors. Defaults to only `loginPath`. */
  isPublic?: (pathname: string) => boolean;
}

export interface ToklynServer<
  TClaims extends ClaimsShape = CustomClaims,
> extends ToklynNext<TClaims> {
  /**
   * Export from `proxy.ts` (or `middleware.ts` before Next 16). Refreshes an expired
   * access cookie and forwards the new one to the page. Redirects signed-out page visits
   * to `loginPath`; other requests pass through so route handlers can answer 401.
   */
  proxy(request: NextRequest): Promise<NextResponse>;
  /** Claims from the access cookie, or null. For server components, actions and routes. */
  getClaims(): Promise<AccessTokenClaims<TClaims> | null>;
  /** Like `getClaims`, but redirects to `loginPath` when signed out. */
  requireClaims(): Promise<AccessTokenClaims<TClaims>>;
}

/** Cookie-mode sessions for server-rendered pages. */
export function createToklynServer<TClaims extends ClaimsShape = CustomClaims>(
  auth: Auth<TClaims>,
  options: ToklynServerOptions,
): ToklynServer<TClaims> {
  const { loginPath, isPublic, ...httpOptions } = options;
  if (
    typeof loginPath !== 'string' ||
    !loginPath.startsWith('/') ||
    loginPath.startsWith('//') ||
    loginPath.includes('\\')
  ) {
    throw new ToklynError('invalid_config', 'loginPath must be a local path');
  }
  const isPublicPath = isPublic ?? ((pathname) => pathname === loginPath);
  const http = createToklynHttp(auth, {
    ...httpOptions,
    accessToken: 'cookie',
  });

  async function getClaims() {
    return http.readClaims((await headers()).get('cookie'));
  }

  return {
    ...routeHandlers(http),
    getClaims,

    async requireClaims() {
      const claims = await getClaims();
      if (claims === null) redirect(loginPath);
      return claims;
    },

    async proxy(request) {
      const result = await http.resolve(toHttpRequest(request));

      if (result.status === 'unavailable') {
        return appendHeaders(
          NextResponse.json({ error: 'service_unavailable' }, { status: 503 }),
          result.headers,
        );
      }

      const { pathname, search } = request.nextUrl;
      if (
        result.status === 'unauthenticated' &&
        isPageVisit(request) &&
        !isPublicPath(pathname)
      ) {
        const url = new URL(loginPath, request.url);
        url.searchParams.set('from', pathname + search);
        return appendHeaders(NextResponse.redirect(url), result.headers);
      }

      const forwarded = new Headers(request.headers);
      if (result.cookie === null) forwarded.delete('cookie');
      else forwarded.set('cookie', result.cookie);
      return appendHeaders(
        NextResponse.next({ request: { headers: forwarded } }),
        result.headers,
      );
    },
  };
}

/** Document loads and client-side navigations (RSC requests). */
function isPageVisit(request: NextRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return (
    request.headers.get('sec-fetch-dest') === 'document' ||
    request.headers.has('rsc') ||
    (request.headers.get('accept') ?? '').includes('text/html')
  );
}
