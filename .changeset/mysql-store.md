---
'@toklyn/store': minor
---

Add `@toklyn/store/mysql`: `MySqlSessionStore` and `MySqlAccessTokenRevocationStore` for MySQL 8.0+ and MariaDB 10.6+, with `fromTupleQuery` (mysql2) and `fromDirectQuery` (mariadb) adapters, optional prepared statements, `migrate` and `createSchemaSql`. Rotation runs in one locking transaction and is retried on deadlocks.
