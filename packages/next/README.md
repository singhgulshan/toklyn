# @toklyn/next

**Next.js App Router helpers for [toklyn](https://github.com/singhgulshan/toklyn) sessions: route handlers, proxy and server components.**

[![npm](https://img.shields.io/npm/v/@toklyn/next?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/next)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

## Install

```sh
npm install toklyn @toklyn/next
```

Two entry points, depending on where you need the user:

| Import                | Mode   | Use when                                                                                                                                                |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@toklyn/next`        | Bearer | Client components call your route handlers. Uses only Web `Request` and `Response`, so it runs on the Node and Edge runtimes and does not import `next` |
| `@toklyn/next/server` | Cookie | Server components, server actions and the proxy need the user. Requires Next.js 15 or later                                                             |

## Bearer mode

```ts
// lib/auth.ts
import { createToklynNext } from '@toklyn/next';

export const toklyn = createToklynNext(auth); // your createAuth(...) instance
```

```ts
// app/api/login/route.ts
export async function POST(request: Request) {
  const user = await checkPassword(await request.json()); // your credential check
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return toklyn.sessionResponse(await auth.createSession({ subject: user.id }));
}

// app/api/refresh/route.ts
export const POST = toklyn.refresh;

// app/api/logout/route.ts
export const POST = toklyn.logout;

// app/api/sessions/[id]/route.ts
export const DELETE = toklyn.withAuth<
  Request,
  RouteContext<'/api/sessions/[id]'>
>(async (request, { params, claims }) => {
  const { id } = await params;
  // ...check that session `id` belongs to claims.sub, then revoke it
  return new Response(null, { status: 204 });
});
```

## Cookie mode

```ts
// lib/auth.ts
import { createToklynServer } from '@toklyn/next/server';

export const toklyn = createToklynServer(auth, {
  loginPath: '/login',
  isPublic: (pathname) => pathname === '/' || pathname === '/login',
});
```

`auth` must be created with `reuseGraceMs > 0` (for example `10_000`): a page load can send several requests with the same refresh cookie.

```ts
// proxy.ts (middleware.ts before Next.js 16)
import { toklyn } from '@/lib/auth';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  return toklyn.proxy(request);
}

export const config = {
  // Auth routes set the cookies themselves.
  matcher: ['/((?!api/auth/|_next/static|_next/image|favicon.ico).*)'],
};
```

```tsx
// app/dashboard/page.tsx
export default async function Dashboard() {
  const claims = await toklyn.requireClaims(); // redirects to /login when signed out
  return <h1>Hello {claims.sub}</h1>;
}
```

```ts
// app/api/auth/login/route.ts: same as bearer mode, but no token is in the body
// app/api/auth/logout/route.ts
export const POST = toklyn.logout;
```

The proxy refreshes an expired access cookie and forwards the new one to the page in the same request. Signed-out page visits are redirected to `loginPath?from=<path>`; API requests pass through so route handlers can answer `401`.

## API

### `createToklynNext(auth, options?)`

`options` are the [HTTP options](https://github.com/singhgulshan/toklyn#http-options) of `toklyn/http`.

| Member                                | Description                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `refresh(request)`                    | Export as `POST`. Rotates the refresh cookie and returns a new session                                                                       |
| `logout(request)`                     | Export as `POST`. Revokes the session and clears the cookies                                                                                 |
| `sessionResponse(tokens)`             | Login response after `auth.createSession`                                                                                                    |
| `withAuth(handler)`                   | Wraps a route handler; the handler receives the route context plus `claims`                                                                  |
| `withOptionalAuth(handler, options?)` | Like `withAuth`, but guests get `claims: null`. `{ invalidToken: 'ignore' }` also treats invalid tokens as guests; the default answers `401` |

### `createToklynServer(auth, options)`

Everything above, always in cookie mode, plus:

| Member            | Description                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `proxy(request)`  | Export from `proxy.ts`. Refreshes, forwards cookies and redirects signed-out page visits           |
| `getClaims()`     | Claims from the access cookie, or `null`. For server components, server actions and route handlers |
| `requireClaims()` | Like `getClaims`, but redirects to `loginPath` when signed out                                     |

| Option               | Description                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `loginPath`          | Local path for signed-out page visits, for example `/login`                                  |
| `isPublic(pathname)` | Pages shown to signed-out visitors. Defaults to only `loginPath`                             |
| other                | The [HTTP options](https://github.com/singhgulshan/toklyn#http-options) except `accessToken` |

### `jwksRoute(jwks)`

Export as `GET` from `app/.well-known/jwks.json/route.ts` to publish the set from `createJwks`. See [Publishing keys](https://github.com/singhgulshan/toklyn#publishing-keys-jwks).

### `createToklynNextResource(verifier, options?)`

For services that only verify tokens, for example with a `RemoteJwksAccessTokenVerifier`. Returns `withAuth` and `withOptionalAuth` for Bearer tokens. `options.clock` sets the time tokens are checked against.

```ts
const api = createToklynNextResource<AppClaims>(
  new RemoteJwksAccessTokenVerifier({
    url: 'https://auth.example.com/.well-known/jwks.json',
    algorithms: ['ES256'],
  }),
);
export const GET = api.withAuth((request, { claims }) => Response.json(claims));
```

## Links

- [Full documentation](https://github.com/singhgulshan/toklyn#readme)
- [Bearer mode example](https://github.com/singhgulshan/toklyn/tree/main/examples/next)
- [Cookie mode example](https://github.com/singhgulshan/toklyn/tree/main/examples/next-ssr)
- [Security model](https://github.com/singhgulshan/toklyn#security-model)

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
