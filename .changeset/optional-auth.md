---
'toklyn': minor
'@toklyn/express': minor
'@toklyn/nest': minor
'@toklyn/next': minor
---

Add optional authentication for routes that serve guests and signed-in users: `authenticateOptional()` in `toklyn/http`, `optionalAuth()` and `getOptionalAuth()` in Express, `@ToklynOptional()` in NestJS and `withOptionalAuth()` in Next.js. Guests get `null` claims. An invalid or expired token answers `401` by default; pass `{ invalidToken: 'ignore' }` to treat it as a guest.
