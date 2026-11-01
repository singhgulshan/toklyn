# toklyn

**Access and refresh token sessions with rotation, reuse detection and pluggable storage.**

[![npm](https://img.shields.io/npm/v/toklyn?color=cb3837&logo=npm)](https://www.npmjs.com/package/toklyn)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
[![Types](https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

The core of [toklyn](https://github.com/singhgulshan/toklyn): short-lived JWT access tokens, opaque refresh tokens stored as hashes, server-side sessions, rotation on every refresh and session revocation when a used token is presented again.

**[Full documentation](https://github.com/singhgulshan/toklyn#readme)**

## Install

```sh
npm install toklyn
```

Node.js 22.12 or later, or any runtime with Web Crypto. ESM and CommonJS.

## Usage

```ts
import { MemorySessionStore, accessTokensFromEnv, createAuth } from 'toklyn';

interface AppClaims {
  role: string;
}

const auth = createAuth<AppClaims>({
  // HS256 from TOKLYN_SECRET (at least 32 bytes; generate with `openssl rand -base64 32`).
  ...accessTokensFromEnv(),
  sessions: new MemorySessionStore(),
  accessTokenTtlSeconds: 5 * 60,
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  sessionMaxAgeSeconds: 30 * 24 * 60 * 60,
});

const tokens = await auth.createSession({
  subject: user.id,
  claims: { role: user.role },
});
const claims = await auth.verifyAccessToken(tokens.accessToken);
const rotated = await auth.refresh({ refreshToken: tokens.refreshToken });
await auth.revokeSession(claims.sid);
```

## Entry points

| Import              | Contents                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `toklyn`            | `createAuth`, `accessTokensFromEnv`, JWT signer and verifier, `createJwks` and `RemoteJwksAccessTokenVerifier`, in-memory stores, `ToklynError`, types and store contracts                       |
| `toklyn/http`       | `createToklynHttp`: framework-neutral login, refresh, logout and authentication responses, in bearer or cookie mode; `httpOptionsFromEnv`; verify-only `createToklynResource` and `jwksResponse` |
| `toklyn/testing`    | `sessionStoreContract` and `revocationStoreContract`, Vitest suites for custom stores                                                                                                            |
| `toklyn/test-utils` | `createTestAuth` and `createTestClock` for testing your app with any test runner                                                                                                                 |

## Documentation

- [How it works](https://github.com/singhgulshan/toklyn#how-it-works)
- [Configuration](https://github.com/singhgulshan/toklyn#configuration)
- [Signing keys and key rotation](https://github.com/singhgulshan/toklyn#signing-keys)
- [Publishing keys (JWKS)](https://github.com/singhgulshan/toklyn#publishing-keys-jwks) and [verifying on other services](https://github.com/singhgulshan/toklyn#verifying-on-other-services)
- [HTTP integration: bearer and cookie mode](https://github.com/singhgulshan/toklyn#http-integration)
- [Storage and custom stores](https://github.com/singhgulshan/toklyn#storage)
- [Testing your app](https://github.com/singhgulshan/toklyn#testing-your-app)
- [Errors](https://github.com/singhgulshan/toklyn#errors)
- [Security model](https://github.com/singhgulshan/toklyn#security-model)

## Related packages

- [`@toklyn/express`](https://www.npmjs.com/package/@toklyn/express): Express middleware and route handlers
- [`@toklyn/nest`](https://www.npmjs.com/package/@toklyn/nest): NestJS module, guard and decorators
- [`@toklyn/next`](https://www.npmjs.com/package/@toklyn/next): Next.js App Router helpers
- [`@toklyn/store`](https://www.npmjs.com/package/@toklyn/store): PostgreSQL, MySQL/MariaDB, SQLite, MongoDB and Redis (Valkey, Upstash) stores

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
