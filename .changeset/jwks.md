---
'toklyn': minor
'@toklyn/express': minor
'@toklyn/nest': minor
'@toklyn/next': minor
---

Add JWKS support. `createJwks(keys)` publishes the public asymmetric keys (HS keys are never published), served with `jwksHandler` (Express), `jwksRoute` (Next.js) or `jwksResponse` (`toklyn/http`). `RemoteJwksAccessTokenVerifier` verifies tokens against a remote JWKS with key caching, refetch on unknown `kid`, a required algorithm allow-list and `storage_error` (503) when the JWKS is unreachable. Verify-only services get Bearer guards without a session store: `createToklynResource` (`toklyn/http`), `createToklynExpressResource`, `ToklynModule.forResource`/`forResourceAsync` and `createToklynNextResource`.
