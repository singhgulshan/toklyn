---
'@toklyn/postgres': minor
---

New package: PostgreSQL session and access-token revocation stores. Every operation is one SQL statement, so refresh-token rotation is atomic without transactions. Includes `migrate` and `createSchemaSql`, optional `schema` and `tablePrefix`, `purgeExpired`, and adapters for node-postgres, PGlite, postgres.js and Prisma, with opt-in prepared statements.
