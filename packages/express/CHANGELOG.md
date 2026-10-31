# @toklyn/express

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
