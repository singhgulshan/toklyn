# @toklyn/store

## 0.2.0

### Minor Changes

- 002877f: Sessions now have `lastRefreshedAt`: equal to `createdAt` at first, then updated by every successful refresh. In the default `offline` mode access tokens are verified without the store, so this is the last refresh, not the last request.

  Add `auth.revokeOtherSessions(subject, keepSessionId)` for "sign out other devices".

  `Session.lastRefreshedAt` is required, so custom `SessionStore` implementations must store it and set it in `rotate`; the contract suite checks this. `RedisSessionStore` reads sessions written by `@toklyn/redis` 0.1.0 with `lastRefreshedAt` equal to `createdAt`.

- 9db0f4c: New package `@toklyn/store`: session and access-token revocation stores, one import path per database. Replaces `@toklyn/redis`.

  - `@toklyn/store/postgres`: every operation is one SQL statement, so refresh-token rotation is atomic without transactions. Includes `migrate` and `createSchemaSql`, optional `schema` and `tablePrefix`, `purgeExpired`, and adapters for node-postgres, PGlite, postgres.js and Prisma, with opt-in prepared statements.
  - `@toklyn/store/redis`: the stores from `@toklyn/redis`, unchanged. Import from `@toklyn/store/redis` instead; class names, options and stored keys are the same, so existing sessions keep working.

### Patch Changes

- Updated dependencies [002877f]
- Updated dependencies [002877f]
- Updated dependencies [002877f]
  - toklyn@0.2.0
