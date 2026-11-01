---
'@toklyn/store': minor
---

Add `@toklyn/store/sqlite`: `SqliteSessionStore` and `SqliteAccessTokenRevocationStore` for SQLite 3.37+, with `fromSyncDatabase` (`node:sqlite`, better-sqlite3, `bun:sqlite`) and `fromExecuteDatabase` (libSQL/Turso) adapters, `migrate` and `createSchemaSql`. Rotation runs in a `BEGIN IMMEDIATE` transaction and is retried while the database is busy.
