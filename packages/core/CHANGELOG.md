# toklyn

## 0.5.0

### Minor Changes

- 1a2e2c7: Add `accessTokensFromEnv()` (HS256 from `TOKLYN_SECRET`, with `TOKLYN_SECRET_PREVIOUS` for rotation, `TOKLYN_ISSUER` and `TOKLYN_AUDIENCE`), `httpOptionsFromEnv()` in `toklyn/http` (`TOKLYN_ALLOWED_ORIGINS`, `TOKLYN_COOKIE_DOMAIN`), and `toklyn/test-utils` with `createTestAuth` and `createTestClock` for any test runner. Passing keys in code works as before.
- 92cc122: Add JWKS support. `createJwks(keys)` publishes the public asymmetric keys (HS keys are never published), served with `jwksHandler` (Express), `jwksRoute` (Next.js) or `jwksResponse` (`toklyn/http`). `RemoteJwksAccessTokenVerifier` verifies tokens against a remote JWKS with key caching, refetch on unknown `kid`, a required algorithm allow-list and `storage_error` (503) when the JWKS is unreachable. Verify-only services get Bearer guards without a session store: `createToklynResource` (`toklyn/http`), `createToklynExpressResource`, `ToklynModule.forResource`/`forResourceAsync` and `createToklynNextResource`.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- 002877f: Add optional authentication for routes that serve guests and signed-in users: `authenticateOptional()` in `toklyn/http`, `optionalAuth()` and `getOptionalAuth()` in Express, `@ToklynOptional()` in NestJS and `withOptionalAuth()` in Next.js. Guests get `null` claims. An invalid or expired token answers `401` by default; pass `{ invalidToken: 'ignore' }` to treat it as a guest.
- 002877f: Add `onRefresh` to `createAuth`: runs before each refresh of an active session and can keep, replace (stored atomically with the rotation) or reject (revokes the session) its claims. If it throws, nothing is consumed and the refresh fails with `storage_error`.

  Add `auth.logout(refreshToken)`, which revokes the token's session without signing new tokens or emitting `token_refreshed`. The HTTP `logout` flow now uses it.

  Refresh tokens now start with their session id (`<sessionId>.<random>`); the whole string is hashed. Tokens issued by 0.1.0 keep working.

  `AuthConfig` is now generic (`AuthConfig<TClaims>`). A config typed as plain `AuthConfig` passed to `createAuth<MyClaims>()` needs `AuthConfig<MyClaims>`.

- 002877f: Sessions now have `lastRefreshedAt`: equal to `createdAt` at first, then updated by every successful refresh. In the default `offline` mode access tokens are verified without the store, so this is the last refresh, not the last request.

  Add `auth.revokeOtherSessions(subject, keepSessionId)` for "sign out other devices".

  `Session.lastRefreshedAt` is required, so custom `SessionStore` implementations must store it and set it in `rotate`; the contract suite checks this. `RedisSessionStore` reads sessions written by `@toklyn/redis` 0.1.0 with `lastRefreshedAt` equal to `createdAt`.

## 0.1.0

### Minor Changes

- 2889dab: Initial release.
