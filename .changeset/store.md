---
'@toklyn/store': minor
---

New package `@toklyn/store`: session and access-token revocation stores, one import path per database. Replaces `@toklyn/redis`.

- `@toklyn/store/postgres`: every operation is one SQL statement, so refresh-token rotation is atomic without transactions. Includes `migrate` and `createSchemaSql`, optional `schema` and `tablePrefix`, `purgeExpired`, and adapters for node-postgres, PGlite, postgres.js and Prisma, with opt-in prepared statements.
- `@toklyn/store/redis`: the stores from `@toklyn/redis`, unchanged. Import from `@toklyn/store/redis` instead; class names, options and stored keys are the same, so existing sessions keep working.
