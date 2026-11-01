# @toklyn/express

## 0.5.1

### Patch Changes

- Updated dependencies [bfba92e]
  - toklyn@0.5.1

## 0.5.0

### Minor Changes

- 92cc122: Add JWKS support. `createJwks(keys)` publishes the public asymmetric keys (HS keys are never published), served with `jwksHandler` (Express), `jwksRoute` (Next.js) or `jwksResponse` (`toklyn/http`). `RemoteJwksAccessTokenVerifier` verifies tokens against a remote JWKS with key caching, refetch on unknown `kid`, a required algorithm allow-list and `storage_error` (503) when the JWKS is unreachable. Verify-only services get Bearer guards without a session store: `createToklynResource` (`toklyn/http`), `createToklynExpressResource`, `ToklynModule.forResource`/`forResourceAsync` and `createToklynNextResource`.

### Patch Changes

- Updated dependencies [1a2e2c7]
- Updated dependencies [92cc122]
  - toklyn@0.5.0

## 0.4.0

### Patch Changes

- toklyn@0.4.0

## 0.3.0

### Patch Changes

- toklyn@0.3.0

## 0.2.0

### Minor Changes

- 002877f: Add optional authentication for routes that serve guests and signed-in users: `authenticateOptional()` in `toklyn/http`, `optionalAuth()` and `getOptionalAuth()` in Express, `@ToklynOptional()` in NestJS and `withOptionalAuth()` in Next.js. Guests get `null` claims. An invalid or expired token answers `401` by default; pass `{ invalidToken: 'ignore' }` to treat it as a guest.

### Patch Changes

- Updated dependencies [002877f]
- Updated dependencies [002877f]
- Updated dependencies [002877f]
  - toklyn@0.2.0

## 0.1.0

### Minor Changes

- 2889dab: Initial release.

### Patch Changes

- Updated dependencies [2889dab]
  - toklyn@0.1.0
