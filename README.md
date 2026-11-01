# toklyn

**Access and refresh token sessions for TypeScript, with rotation, reuse detection and pluggable storage.**

[![npm](https://img.shields.io/npm/v/toklyn?color=cb3837&logo=npm)](https://www.npmjs.com/package/toklyn)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/toklyn?logo=node.js)](https://nodejs.org)
[![Types](https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

toklyn issues short-lived JWT access tokens and long-lived opaque refresh tokens, stores sessions server-side, rotates the refresh token on every use and revokes the whole session when a used token comes back. You keep your own login logic (passwords, OAuth, magic links); toklyn takes over from "this user is who they claim to be".

## Contents

- [Features](#features)
- [Packages](#packages)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Signing keys](#signing-keys)
- [HTTP integration](#http-integration)
- [Frameworks](#frameworks)
- [Storage](#storage)
- [Testing your app](#testing-your-app)
- [Errors](#errors)
- [Events](#events)
- [Security model](#security-model)
- [Runtime support](#runtime-support)
- [Examples](#examples)
- [Development](#development)
- [License](#license)

## Features

- **Refresh-token rotation with reuse detection.** Every refresh returns a new refresh token. Presenting an old one revokes the session, so a stolen token stops working for both the attacker and the user.
- **Server-side sessions.** List a user's sessions, revoke one, or sign a user out everywhere.
- **Secure defaults.** `HttpOnly`, `Secure`, `__Host-` cookies, `SameSite=Strict`, origin checks on cookie-authenticated writes, `Cache-Control: no-store`, the JWT algorithm pinned by config.
- **Two transports.** Bearer tokens for SPAs and APIs, or HttpOnly access cookies for server-rendered pages.
- **JWKS.** Publish your public keys and verify tokens on other services, with key caching and rotation.
- **Framework adapters** for Express, NestJS and Next.js, built on one framework-neutral HTTP layer.
- **Pluggable storage.** In-memory for development, PostgreSQL, MySQL/MariaDB, SQLite, MongoDB or Redis/Valkey/Upstash for production with the client you already use, or your own store, checked by a shipped contract test suite.
- **Typed claims.** Your claims type flows through to every verified token; reserved JWT claim names are rejected at compile time and at runtime.
- **Small and portable.** One runtime dependency ([`jose`](https://github.com/panva/jose)), Web Crypto only, ESM and CommonJS builds.

## Packages

| Package                               | Description                                                                                                                                     | Version                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`toklyn`](packages/core)             | Core: sessions, tokens, stores, plus `toklyn/http`, `toklyn/testing` and `toklyn/test-utils`                                                    | [![npm](https://img.shields.io/npm/v/toklyn?label=)](https://www.npmjs.com/package/toklyn)                   |
| [`@toklyn/express`](packages/express) | Express 5 middleware and route handlers                                                                                                         | [![npm](https://img.shields.io/npm/v/@toklyn/express?label=)](https://www.npmjs.com/package/@toklyn/express) |
| [`@toklyn/nest`](packages/nest)       | NestJS module, guard and decorators                                                                                                             | [![npm](https://img.shields.io/npm/v/@toklyn/nest?label=)](https://www.npmjs.com/package/@toklyn/nest)       |
| [`@toklyn/next`](packages/next)       | Next.js App Router route handlers, proxy and server-component helpers                                                                           | [![npm](https://img.shields.io/npm/v/@toklyn/next?label=)](https://www.npmjs.com/package/@toklyn/next)       |
| [`@toklyn/store`](packages/store)     | PostgreSQL (`/postgres`), MySQL/MariaDB (`/mysql`), SQLite (`/sqlite`), MongoDB (`/mongodb`) and Redis (`/redis`) session and revocation stores | [![npm](https://img.shields.io/npm/v/@toklyn/store?label=)](https://www.npmjs.com/package/@toklyn/store)     |

All packages share one version number and are released together.

## Install

```sh
npm install toklyn
# plus the adapter you need, for example:
npm install @toklyn/express
# and a production store:
npm install @toklyn/store
```

Requires Node.js 22.12 or later.

## Quick start

```sh
# .env (generate with `openssl rand -base64 32` and keep it in your secret manager)
TOKLYN_SECRET=q7Vh3kZ1x9Lr2Yt0cWb8NfJmA4sPeD6uGiHoKjRlTzE=
```

```ts
import { MemorySessionStore, accessTokensFromEnv, createAuth } from 'toklyn';

interface AppClaims {
  role: string;
}

const auth = createAuth<AppClaims>({
  ...accessTokensFromEnv(), // HS256 signer and verifier from TOKLYN_SECRET
  sessions: new MemorySessionStore(),
  accessTokenTtlSeconds: 5 * 60,
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  sessionMaxAgeSeconds: 30 * 24 * 60 * 60,
});

// 1. After your own credential check:
const tokens = await auth.createSession({
  subject: user.id,
  claims: { role: user.role },
  metadata: { userAgent: 'Firefox on macOS' },
});

// 2. On every request:
const claims = await auth.verifyAccessToken(tokens.accessToken);
claims.sub; // user id
claims.role; // typed as string

// 3. When the access token expires:
const rotated = await auth.refresh({ refreshToken: tokens.refreshToken });

// 4. On logout:
await auth.revokeSession(claims.sid);
```

A missing secret or one shorter than 32 bytes throws at startup, so a misconfigured deploy fails fast instead of signing with a weak key. To pass keys in code or use asymmetric keys, see [Signing keys](#signing-keys).

In a web app you rarely call `refresh` yourself: the [HTTP layer](#http-integration) and the [framework adapters](#frameworks) handle cookies, refresh and logout routes for you.

## How it works

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Your server + toklyn
    participant DB as Session store
    C->>S: login (your credential check)
    S->>DB: create session + hash of refresh token R1
    S-->>C: access token A1 (JWT) + refresh cookie R1
    C->>S: API call with A1
    S-->>C: 200 (signature and expiry checked, no store call)
    C->>S: refresh with R1
    S->>DB: atomically consume R1, store R2
    S-->>C: A2 + R2
    C->>S: refresh with R1 again (stolen copy)
    S->>DB: R1 already consumed: revoke session
    S-->>C: 401, R2 is now dead too
```

- **Access tokens** are JWTs with `sub`, `sid` (session id), `jti`, `iat`, `exp`, plus your claims. They never outlive their session.
- **Refresh tokens** are `<sessionId>.<256-bit random>`. Only the SHA-256 hash of the whole string is stored, so changing the session id makes the token unknown.
- **Sessions** have an absolute lifetime (`sessionMaxAgeSeconds`) that rotation never extends. A refresh token expires at `min(now + refreshTokenTtlSeconds, session expiry)`.
- **Rotation** is one atomic store operation: validate, consume, insert the successor, or revoke on reuse. Two concurrent refreshes with the same token can never both succeed outside the grace window.
- **Grace window.** `reuseGraceMs` (default `0`, strict) lets a just-consumed token be used again for a short time, for clients that legitimately send parallel refreshes. Cookie mode requires it.

### Checking the user on refresh

`onRefresh` runs before each refresh of an active session, so a disabled user is signed out and role changes reach the next access token:

```ts
const auth = createAuth<{ role: string }>({
  // ...
  async onRefresh(session) {
    const user = await users.findById(session.subject);
    if (!user?.active) return null; // revokes the session, refresh answers 401
    if (user.role !== session.claims.role) return { role: user.role }; // stored and signed
    return undefined; // keep the current claims
  },
});
```

The hook runs before the refresh token is consumed. If it throws, the refresh fails with `storage_error` (HTTP 503) and the same token can be retried. Returned claims are stored in the same atomic step as the rotation. Tokens issued by 0.1.0 have no session id, so for those the hook runs after rotation until the session ends.

### Verification modes

| Mode                | Checks                                                                                                     | Store call per request | Revocation takes effect       |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------- |
| `offline` (default) | Signature, algorithm, issuer, audience, expiry                                                             | No                     | When the access token expires |
| `online`            | All of the above, plus the session exists and is active, plus the `jti` denylist when `revocations` is set | Yes                    | Immediately                   |

`online` fails closed: if the store is unreachable, verification throws `storage_error` (HTTP 503) instead of letting the request through. Keep access tokens short-lived in `offline` mode; 5 to 15 minutes is typical.

## Configuration

`createAuth<TClaims>(config)` returns an [`Auth`](packages/core/src/auth.ts) object.

| Option                   | Type                                       | Default      | Description                                                             |
| ------------------------ | ------------------------------------------ | ------------ | ----------------------------------------------------------------------- |
| `signer`                 | `AccessTokenSigner`                        | required     | From `accessTokensFromEnv()` or `new JwtAccessTokenSigner(keyConfig)`   |
| `verifier`               | `AccessTokenVerifier`                      | required     | From `accessTokensFromEnv()` or `new JwtAccessTokenVerifier(keyConfig)` |
| `sessions`               | `SessionStore`                             | required     | See [Storage](#storage)                                                 |
| `accessTokenTtlSeconds`  | `number`                                   | required     | Access token lifetime                                                   |
| `refreshTokenTtlSeconds` | `number`                                   | required     | Lifetime of each refresh token (sliding)                                |
| `sessionMaxAgeSeconds`   | `number`                                   | required     | Absolute session lifetime from creation                                 |
| `verification`           | `'offline' \| 'online'`                    | `'offline'`  | See [Verification modes](#verification-modes)                           |
| `revocations`            | `AccessTokenRevocationStore`               | none         | Denylist for single access tokens; needed by `revokeAccessToken`        |
| `reuseGraceMs`           | `number`                                   | `0`          | Grace window for reusing a just-rotated refresh token                   |
| `onRefresh`              | `(session) => claims \| null \| undefined` | none         | See [Checking the user on refresh](#checking-the-user-on-refresh)       |
| `onEvent`                | `(event: AuthEvent) => void`               | none         | See [Events](#events)                                                   |
| `refreshTokens`          | `RefreshTokenCodec`                        | Web Crypto   | Custom refresh-token generation and hashing                             |
| `clock`                  | `Clock`                                    | system clock | Inject time in tests                                                    |

| Method                                           | Description                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `createSession({ subject, claims?, metadata? })` | Starts a session and returns a `TokenPair`                                                            |
| `refresh({ refreshToken, claims? })`             | Rotates the refresh token; `claims` replaces the stored claims, for example after a role change       |
| `logout(refreshToken)`                           | Revokes the token's session; ignores invalid or already revoked tokens                                |
| `verifyAccessToken(token)`                       | Returns the typed claims or throws a `ToklynError`                                                    |
| `revokeSession(sessionId)`                       | Revokes one session (idempotent)                                                                      |
| `revokeAllSessions(subject)`                     | Signs a user out everywhere                                                                           |
| `revokeOtherSessions(subject, keepSessionId)`    | Signs a user out everywhere except the current session (`claims.sid`)                                 |
| `listSessions(subject)`                          | Active sessions with `createdAt` and `lastRefreshedAt`, for a "your devices" page                     |
| `revokeAccessToken(token)`                       | Denylists one access token until it expires; requires `revocations` and takes effect in `online` mode |

## Signing keys

The algorithm always comes from your config, never from the token header ([RFC 8725 §3.1](https://www.rfc-editor.org/rfc/rfc8725#section-3.1)).

### From environment variables

`accessTokensFromEnv(options?)` returns an HS256 `signer` and `verifier` to spread into `createAuth`. Nothing reads the environment unless you call it.

| Variable                 | Required | Description                                                                         |
| ------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `TOKLYN_SECRET`          | yes      | Signing secret, at least 32 bytes. Any text; it is used as is, not base64-decoded   |
| `TOKLYN_SECRET_PREVIOUS` | no       | Old secret, accepted for verification only, so rotating the secret signs nobody out |
| `TOKLYN_ISSUER`          | no       | Sets and checks `iss`                                                               |
| `TOKLYN_AUDIENCE`        | no       | Sets and checks `aud`; comma-separated for several                                  |

- Generate the secret with `openssl rand -base64 32` (or `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`). Prefer a generated value over a passphrase.
- Each key gets a `kid` derived from a hash of its secret, so rotation needs no key names: move the current value to `TOKLYN_SECRET_PREVIOUS`, set a new `TOKLYN_SECRET`, and remove the previous one once the last old access token has expired.
- A missing or short secret throws `invalid_config` at startup; the message never contains the value. Empty variables count as unset.
- It reads `process.env` by default. On runtimes without it, such as Cloudflare Workers, pass the env object: `accessTokensFromEnv({ env })`.
- Another service verifying these tokens must use the same text as the HMAC key, not its base64-decoded bytes.

### In code

**HMAC** (`HS256`, `HS384`, `HS512`): the secret must be at least as long as the hash output, so 32, 48 or 64 bytes ([RFC 7518 §3.2](https://www.rfc-editor.org/rfc/rfc7518#section-3.2)).

**Asymmetric** (`RS*`, `PS*`, `ES*`, `EdDSA`): pass `CryptoKey` objects. Services that only verify tokens omit `privateKey`.

```ts
import { importPKCS8, importSPKI } from 'jose';

const keyConfig = {
  issuer: 'https://auth.example.com',
  audience: 'https://api.example.com',
  keys: [
    {
      kid: '2026-10',
      algorithm: 'ES256' as const,
      privateKey: await importPKCS8(privateKeyPem, 'ES256'),
      publicKey: await importSPKI(publicKeyPem, 'ES256'),
    },
  ],
};
```

**Rotation.** List several keys, each with a `kid`, and choose the one that signs with `signingKid`. Keep the old key until its last token has expired:

```ts
const keyConfig = {
  signingKid: '2026-11',
  keys: [
    { kid: '2026-11', algorithm: 'HS256' as const, secret: newSecret },
    { kid: '2026-10', algorithm: 'HS256' as const, secret: oldSecret },
  ],
};
```

Give your key a `kid` from the start. A token without a `kid` can only be verified while exactly one key is configured.

| `AccessTokenConfig` option | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `keys`                     | Keys accepted for verification                       |
| `signingKid`               | Key that signs; required when there are several keys |
| `issuer`                   | Sets and checks `iss`                                |
| `audience`                 | Sets and checks `aud`                                |
| `clockToleranceSeconds`    | Allowed clock skew when checking `exp`; default `0`  |

### Publishing keys (JWKS)

With asymmetric keys, other services can verify tokens without any secret. `createJwks(keys)` builds a JSON Web Key Set ([RFC 7517](https://www.rfc-editor.org/rfc/rfc7517)) from your key config, and the adapters serve it:

```ts
import { createJwks } from 'toklyn';

const jwks = await createJwks(keyConfig.keys);

app.get('/.well-known/jwks.json', jwksHandler(jwks)); // Express
export const GET = jwksRoute(jwks); // Next.js: app/.well-known/jwks.json/route.ts
```

- Only public parameters are published, with `kid`, `alg` and `use: "sig"`. HS keys are skipped, since publishing them would publish the secret.
- Every published key needs a `kid`. Public keys must be extractable: `importSPKI(pem, alg, { extractable: true })`.
- The response has `Cache-Control: public, max-age=300`. When rotating, publish the new key, wait for caches to pick it up, and only then sign with it (`signingKid`). Keep the old key published until its last token has expired.
- In NestJS, return the set from a `@ToklynPublic()` controller method with `@Header('Cache-Control', 'public, max-age=300')`.
- For any other framework, `jwksResponse(jwks)` from `toklyn/http` returns the status, headers and body.

### Verifying on other services

`RemoteJwksAccessTokenVerifier` verifies tokens against a published JWKS:

```ts
import { RemoteJwksAccessTokenVerifier } from 'toklyn';

const verifier = new RemoteJwksAccessTokenVerifier({
  url: 'https://auth.example.com/.well-known/jwks.json',
  algorithms: ['ES256'],
  issuer: 'https://auth.example.com',
  audience: 'https://api.example.com',
});
```

| Option                  | Default  | Description                                                    |
| ----------------------- | -------- | -------------------------------------------------------------- |
| `url`                   | required | `https`, or `http` on `localhost` only                         |
| `algorithms`            | required | Accepted asymmetric algorithms; the token header never chooses |
| `issuer`, `audience`    | none     | Checks `iss` and `aud`                                         |
| `clockToleranceSeconds` | `0`      | Allowed clock skew when checking `exp`                         |
| `timeoutMs`             | `5000`   | Fetch timeout                                                  |
| `cooldownMs`            | `30000`  | Minimum time between refetches caused by an unknown `kid`      |
| `cacheMaxAgeMs`         | `600000` | Keys are refetched when older than this                        |
| `fetch`                 | global   | Custom `fetch`, for example to go through a proxy              |

- Keys are fetched on first use and cached. A token with an unknown `kid` triggers a refetch, at most once per cooldown, so key rotation needs no restart.
- A JWKS that cannot be fetched or parsed gives `storage_error` (HTTP `503`); a bad token gives `invalid_access_token` (HTTP `401`).
- Checks are offline: signature, algorithm, issuer, audience and expiry. A revoked session's access tokens keep working until they expire, so keep them short-lived.

Services that only verify tokens have no session store, so they use the verify-only guards instead of `Auth`. They accept Bearer tokens only:

```ts
// Express
const api = createToklynExpressResource(verifier);
app.get('/api/me', api.requireAuth, (req, res) => res.json(getAuth(req)));

// NestJS
ToklynModule.forResource({ verifier }); // ToklynAuthGuard, @ToklynClaims() and @ToklynOptional() work as usual

// Next.js
const api = createToklynNextResource(verifier);
export const GET = api.withAuth((request, { claims }) => Response.json(claims));

// Any other framework
const resource = createToklynResource(verifier); // from 'toklyn/http': authenticate, authenticateOptional
```

## HTTP integration

`toklyn/http` turns `Auth` into framework-neutral request handlers. The adapters are thin wrappers around it; use it directly for any other framework.

```ts
import { createToklynHttp } from 'toklyn/http';

const http = createToklynHttp(auth, {
  allowedOrigins: ['https://app.example.com'],
});

// With a Web `Request`:
const result = await http.authenticate({
  method: request.method,
  header: (name) => request.headers.get(name),
});
// result.ok ? result.claims : send result.response (status, headers, JSON body)
```

### Bearer mode

The default, for SPAs and API clients.

- Login and refresh return the access token in the JSON body. The client keeps it **in memory** and sends `Authorization: Bearer <token>`.
- The refresh token is an `HttpOnly` cookie, `__Host-toklyn_refresh`, `SameSite=Strict`, so JavaScript never sees it.
- On page load and on a `401`, the client calls the refresh route once and retries. Send only one refresh at a time; see [`examples/express/public/app.js`](examples/express/public/app.js).

### Cookie mode

`accessToken: 'cookie'`, for server-rendered pages that need the user during rendering.

- Both tokens are `HttpOnly` cookies (`__Host-toklyn_access` and `__Host-toklyn_refresh`), `SameSite=Lax` by default. The response body has no token.
- Methods other than `GET`, `HEAD` and `OPTIONS` need a trusted origin, which protects against CSRF.
- `resolve(request)` refreshes an expired access cookie in middleware and returns the cookies to forward, so the page sees the new token in the same request.
- Requires `reuseGraceMs > 0` on `auth` (10 seconds works well), because a page load can trigger several parallel requests with the same refresh cookie.

### Optional authentication

For routes that serve guests and signed-in users, `authenticateOptional(request, options?)` returns `claims: null` when there is no access token. In cookie mode, untrusted cross-site writes are treated as guests.

| `invalidToken`       | Invalid or expired token                                    |
| -------------------- | ----------------------------------------------------------- |
| `'reject'` (default) | `401`, so the client refreshes instead of seeing guest data |
| `'ignore'`           | Treated as a guest                                          |

Storage errors in `online` mode always give `503`. The adapters expose it as `optionalAuth()` (Express), `@ToklynOptional()` (NestJS) and `withOptionalAuth()` (Next.js).

### HTTP options

| Option           | Type                   | Default                                           | Description                                                                            |
| ---------------- | ---------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `accessToken`    | `'bearer' \| 'cookie'` | `'bearer'`                                        | Where the access token travels                                                         |
| `cookie`         | `CookieOptions`        | `toklyn_refresh`, `Strict` (`Lax` in cookie mode) | Refresh cookie                                                                         |
| `accessCookie`   | `CookieOptions`        | `toklyn_access`, `Lax`                            | Access cookie, cookie mode only                                                        |
| `allowedOrigins` | `string[]`             | `[]`                                              | Origins trusted for cookie-authenticated writes, for example `https://app.example.com` |
| `clock`          | `Clock`                | system clock                                      | Used for cookie `Max-Age`                                                              |

| `CookieOptions` | Default   | Notes                                                                                                             |
| --------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`          | see above | Base name. `__Host-` is prepended when `secure`, `path: '/'` and no `domain`; otherwise `__Secure-` when `secure` |
| `path`          | `'/'`     |                                                                                                                   |
| `domain`        | host-only | Setting it drops the `__Host-` prefix                                                                             |
| `secure`        | `true`    | Set `false` only for local development over plain HTTP                                                            |
| `sameSite`      | see above | `'Strict'`, `'Lax'` or `'None'`; `'None'` requires `secure` and a non-empty `allowedOrigins`                      |

Every option is validated when you call `createToklynHttp`; an invalid value throws `invalid_config`.

`httpOptionsFromEnv(options?, { env? })` from `toklyn/http` adds `TOKLYN_ALLOWED_ORIGINS` (comma-separated) and `TOKLYN_COOKIE_DOMAIN` (both cookies) to your options. Values you set in code win. Setting a domain changes the cookie prefix from `__Host-` to `__Secure-`, which signs out existing sessions.

```ts
const http = createToklynHttp(
  auth,
  httpOptionsFromEnv({ accessToken: 'cookie' }),
);
```

**Trusted origin** means the browser sent `Sec-Fetch-Site: same-origin`, or an `Origin` listed in `allowedOrigins`. Requests with neither header are rejected. The refresh and logout routes always require it, so non-browser clients must send an allowed `Origin`.

### Responses

| Handler                | Success                                 | Failure                                                                                                          |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `issue(tokens)`        | `200`, cookies, session body            | none                                                                                                             |
| `authenticate`         | claims                                  | `401` (with `WWW-Authenticate: Bearer` in bearer mode), `403` untrusted write in cookie mode, `503` storage down |
| `authenticateOptional` | claims, or `null` for a guest           | `401` invalid token (unless `invalidToken: 'ignore'`), `503` storage down                                        |
| `refresh`              | `200`, new cookies, session body        | `403` untrusted origin, `401` and cookies cleared, `503` with cookies kept                                       |
| `logout`               | `204`, cookies cleared, session revoked | `403` untrusted origin, `503`                                                                                    |

All responses carry `Cache-Control: no-store`. Every authentication failure returns the same `{"error":"unauthorized"}` body, so a client cannot tell an expired token from a forged one.

## Frameworks

### Express

```ts
import { createToklynExpress, getAuth, getOptionalAuth } from '@toklyn/express';

const toklyn = createToklynExpress(auth);

app.post('/api/login', async (req, res) => {
  const user = await checkPassword(req.body);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  toklyn.sendSession(res, await auth.createSession({ subject: user.id }));
});
app.post('/api/refresh', toklyn.refreshHandler);
app.post('/api/logout', toklyn.logoutHandler);
app.get('/api/me', toklyn.requireAuth, (req, res) =>
  res.json(getAuth<AppClaims>(req)),
);
app.get('/api/feed', toklyn.optionalAuth(), (req, res) =>
  res.json(feedFor(getOptionalAuth(req)?.sub ?? null)),
);
```

More in the [`@toklyn/express` README](packages/express) and [`examples/express`](examples/express).

### NestJS

```ts
@Module({
  imports: [ToklynModule.forRoot({ auth })],
  providers: [{ provide: APP_GUARD, useClass: ToklynAuthGuard }],
})
export class AppModule {}

@Controller('api')
export class MeController {
  @Get('me')
  me(@ToklynClaims() claims: AccessTokenClaims<AppClaims>) {
    return claims;
  }

  @ToklynOptional()
  @Get('feed')
  feed(@ToklynClaims() claims: AccessTokenClaims<AppClaims> | null) {
    return feedFor(claims?.sub ?? null);
  }
}
```

More in the [`@toklyn/nest` README](packages/nest) and [`examples/nest`](examples/nest).

### Next.js

Bearer mode for client-side apps, with route handlers only:

```ts
// app/api/refresh/route.ts
export const POST = toklyn.refresh;

// app/api/me/route.ts
export const GET = toklyn.withAuth((request, { claims }) =>
  Response.json(claims),
);

// app/api/feed/route.ts: claims is null for guests
export const GET = toklyn.withOptionalAuth((request, { claims }) =>
  Response.json(feedFor(claims?.sub ?? null)),
);
```

Cookie mode for server components, server actions and the proxy:

```ts
// proxy.ts
export function proxy(request: NextRequest) {
  return toklyn.proxy(request);
}

// app/dashboard/page.tsx
const claims = await toklyn.requireClaims();
```

More in the [`@toklyn/next` README](packages/next), [`examples/next`](examples/next) and [`examples/next-ssr`](examples/next-ssr).

## Storage

| Store                                                        | Package                                                    | Use for                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `MemorySessionStore`, `MemoryAccessTokenRevocationStore`     | `toklyn`                                                   | Development and tests. State is per process and lost on restart                         |
| `PostgresSessionStore`, `PostgresAccessTokenRevocationStore` | [`@toklyn/store/postgres`](packages/store#postgresql)      | Production: PostgreSQL with any driver; one statement per operation, no transactions    |
| `MySqlSessionStore`, `MySqlAccessTokenRevocationStore`       | [`@toklyn/store/mysql`](packages/store#mysql-and-mariadb)  | Production: MySQL 8.0+ or MariaDB 10.6+ (InnoDB); rotation in one locking transaction   |
| `SqliteSessionStore`, `SqliteAccessTokenRevocationStore`     | [`@toklyn/store/sqlite`](packages/store#sqlite)            | Single-server apps: SQLite 3.37+ via `node:sqlite`, better-sqlite3, Bun or libSQL/Turso |
| `MongoSessionStore`, `MongoAccessTokenRevocationStore`       | [`@toklyn/store/mongodb`](packages/store#mongodb)          | Production: MongoDB 6.0+ (standalone, replica set or Atlas); no transactions needed     |
| `RedisSessionStore`, `RedisAccessTokenRevocationStore`       | [`@toklyn/store/redis`](packages/store#redis)              | Production: Redis 6.2+, built for Valkey, Upstash and Redis Cluster                     |
| Your own                                                     | implement [`SessionStore`](packages/core/src/contracts.ts) | Any database with atomic updates                                                        |

A custom `SessionStore` must make `rotate` atomic and set `session.lastRefreshedAt` on every successful rotation. Check your implementation with the contract suites from `toklyn/testing` (requires [Vitest](https://vitest.dev)):

```ts
import { revocationStoreContract, sessionStoreContract } from 'toklyn/testing';

sessionStoreContract('DynamoSessionStore', () => new DynamoSessionStore(table));
revocationStoreContract(
  'DynamoRevocations',
  (clock) => new DynamoRevocations(table, clock),
);
```

## Testing your app

`toklyn/test-utils` works with any test runner (Vitest, Jest, `node:test`). `createTestAuth(options?)` returns an `auth` with a random HS256 key, in-memory stores and a clock that only moves when you tell it to:

```ts
import { createTestAuth } from 'toklyn/test-utils';

const { auth, clock, sessions } = createTestAuth<{ role: string }>({
  accessTokenTtlSeconds: 60,
});
const tokens = await auth.createSession({
  subject: 'user-1',
  claims: { role: 'admin' },
});

clock.advance(61_000);
await auth.verifyAccessToken(tokens.accessToken); // throws access_token_expired
```

Every `createAuth` option can be overridden except `clock`; `startAt` sets the start time. `createTestClock(startAt?)` is exported too. Never use it in production: the key changes on every call and sessions live in memory.

## Errors

Every failure is a `ToklynError` with a stable `code`:

| Code                    | When                                                                   | HTTP layer |
| ----------------------- | ---------------------------------------------------------------------- | ---------- |
| `invalid_config`        | Invalid options at startup, or signing failed                          | thrown     |
| `invalid_input`         | Empty subject, reserved claim name, non-object claims                  | thrown     |
| `invalid_access_token`  | Bad signature, algorithm, issuer, audience or shape                    | `401`      |
| `access_token_expired`  | `exp` has passed                                                       | `401`      |
| `access_token_revoked`  | `jti` is denylisted (`online` mode)                                    | `401`      |
| `invalid_refresh_token` | Unknown or malformed refresh token                                     | `401`      |
| `refresh_token_expired` | Refresh token past its expiry                                          | `401`      |
| `refresh_token_reused`  | A consumed token was presented again; the session is now revoked       | `401`      |
| `session_not_found`     | Session is gone (`online` mode)                                        | `401`      |
| `session_expired`       | Session reached `sessionMaxAgeSeconds`                                 | `401`      |
| `session_revoked`       | Session was revoked                                                    | `401`      |
| `storage_error`         | The store threw or was unreachable; the cause is kept in `error.cause` | `503`      |

```ts
import { ToklynError } from 'toklyn';

try {
  await auth.refresh({ refreshToken });
} catch (error) {
  if (error instanceof ToklynError && error.code === 'refresh_token_reused') {
    // Possible token theft: alert the user.
  }
  throw error;
}
```

## Events

```ts
createAuth({
  // ...
  onEvent(event) {
    if (event.type === 'refresh_reuse_detected') {
      logger.warn(
        { subject: event.subject, sessionId: event.sessionId },
        'refresh token reuse',
      );
    }
  },
});
```

| Event                    | When                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `session_created`        | `createSession` succeeded                                                |
| `token_refreshed`        | `refresh` rotated a token                                                |
| `refresh_reuse_detected` | A consumed refresh token came back; always followed by `session_revoked` |
| `session_revoked`        | A session was revoked by you or by reuse detection                       |

A listener that throws never breaks authentication.

## Security model

What toklyn does:

- Rotates refresh tokens and revokes the session on reuse, as recommended by the OAuth 2.0 Security Best Current Practice ([RFC 9700 §4.14](https://www.rfc-editor.org/rfc/rfc9700#section-4.14)).
- Stores only SHA-256 hashes of refresh tokens, so a database leak does not leak usable tokens.
- Pins the JWT algorithm per key and requires `sub`, `sid`, `jti`, `iat` and `exp` ([RFC 8725](https://www.rfc-editor.org/rfc/rfc8725)).
- Enforces minimum HMAC key sizes ([RFC 7518 §3.2](https://www.rfc-editor.org/rfc/rfc7518#section-3.2)) and copies secrets so later buffer changes cannot alter a live key.
- Sets cookies `HttpOnly`, `Secure` and with the [`__Host-` prefix](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes), and treats duplicate cookies with different values as missing, which blocks cookie tossing from sibling subdomains.
- Checks [Fetch Metadata](https://web.dev/articles/fetch-metadata) and `Origin` on cookie-authenticated writes ([OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).
- Returns identical `401` responses for every authentication failure and `Cache-Control: no-store` on every response.
- Bounds the length of presented tokens, limiting the work an attacker can force.

What stays your responsibility:

- Verifying credentials (password hashing, rate limiting, MFA) before `createSession`.
- Keeping secrets and private keys out of source control.
- Serving over HTTPS. `secure: false` is for local development only.
- Accepting that in `offline` mode a revoked session's access token remains valid until it expires. Use short access-token lifetimes, or `online` mode where immediate revocation matters.
- Protecting against XSS. Tokens in `HttpOnly` cookies cannot be read by scripts, but an XSS can still make requests as the user.

See also the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Runtime support

- Node.js 22.12 or later, ESM and CommonJS.
- Only Web Crypto and standard Web APIs, no Node built-ins: `toklyn` and `@toklyn/next` are tested on Node and on the [Edge Runtime](https://github.com/vercel/edge-runtime).
- TypeScript types included, built and tested with `strict` and `noUncheckedIndexedAccess`.
- Framework versions: Express 5, NestJS 9 or later (Express and Fastify platforms), Next.js 15 or later for `@toklyn/next/server`.

## Examples

Runnable apps in [`examples/`](examples), each with a demo login (`demo` / `demo`):

| Example                                  | Shows                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`examples/express`](examples/express)   | Express API and a vanilla JS client with in-memory access token and single-flight refresh |
| [`examples/nest`](examples/nest)         | NestJS with a global guard and `@ToklynPublic()` routes                                   |
| [`examples/next`](examples/next)         | Next.js route handlers in bearer mode, with a sessions page                               |
| [`examples/next-ssr`](examples/next-ssr) | Next.js cookie mode: proxy, server components, server actions                             |

```sh
pnpm install
pnpm build
pnpm --filter @toklyn/example-express start   # or example-nest start, example-next dev, example-next-ssr dev
```

The Express example runs TypeScript directly and needs Node.js 22.18 or later.

## Development

```sh
pnpm install
pnpm build
pnpm test              # Redis tests need a server at REDIS_URL (default redis://localhost:6379); real-server Postgres, MySQL, MariaDB and MongoDB tests run when POSTGRES_URL, MYSQL_URL, MARIADB_URL or MONGODB_URL is set; SQLite needs no server
pnpm --filter @toklyn/store test:bun   # bun:sqlite tests; needs Bun and a prior pnpm build
pnpm test:edge
pnpm lint
pnpm typecheck
pnpm format:check
pnpm check:exports     # are-the-types-wrong on every package
```

Releases use [Changesets](https://github.com/changesets/changesets):

```sh
pnpm changeset          # describe a change (patch, minor or major)
pnpm version-packages   # bump versions and write changelogs
pnpm release            # build and publish to npm
```

## License

[MIT](LICENSE)
