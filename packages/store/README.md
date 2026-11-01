# @toklyn/store

**PostgreSQL, MySQL/MariaDB, SQLite, MongoDB and Redis session and access-token revocation stores for [toklyn](https://github.com/singhgulshan/toklyn).**

[![npm](https://img.shields.io/npm/v/@toklyn/store?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/store)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

One package, one import path per database. Each store is written natively for its database, so refresh-token rotation is atomic across all your server instances, and an app only loads the database it imports.

| Import                   | Database                                                 | Atomic rotation                              |
| ------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| `@toklyn/store/postgres` | PostgreSQL (tested on 17 and 18), PGlite, Neon           | One SQL statement                            |
| `@toklyn/store/mysql`    | MySQL 8.0+, MariaDB 10.6+ (InnoDB)                       | One transaction with row locks               |
| `@toklyn/store/sqlite`   | SQLite 3.37+: `node:sqlite`, better-sqlite3, Bun, libSQL | One transaction holding the write lock       |
| `@toklyn/store/mongodb`  | MongoDB 6.0+: standalone, replica set or Atlas           | One compare-and-swap on the session document |
| `@toklyn/store/redis`    | Redis 6.2+, Valkey, Upstash, Redis Cluster               | One Lua script                               |

No runtime dependencies: bring the database client your app already uses. Every store passes the same contract tests from `toklyn/testing`, plus a parallel-refresh race test against a real server.

## Install

```sh
npm install toklyn @toklyn/store
```

## PostgreSQL

Clients: [`pg`](https://node-postgres.com) (node-postgres), [`postgres`](https://github.com/porsager/postgres) (postgres.js), [`@electric-sql/pglite`](https://pglite.dev), [`@neondatabase/serverless`](https://github.com/neondatabase/serverless) `Pool` or Prisma.

```ts
import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromResultQuery,
  migrate,
} from '@toklyn/store/postgres';
import pg from 'pg';
import { createAuth } from 'toklyn';

const client = fromResultQuery(
  new pg.Pool({ connectionString: process.env.DATABASE_URL }),
);
await migrate(client); // or put createSchemaSql() in your migrations

const auth = createAuth({
  // ...signer, verifier and lifetimes
  sessions: new PostgresSessionStore({ client }),
  revocations: new PostgresAccessTokenRevocationStore({ client }), // optional
});
```

Every operation is a single SQL statement, so rotation needs no transaction. Row locks cover only the session being refreshed.

Pick the adapter that matches your client:

| Client                                                    | Adapter                          |
| --------------------------------------------------------- | -------------------------------- |
| node-postgres, PGlite, Neon `Pool`: `query(text, params)` | `fromResultQuery(pool)`          |
| postgres.js: `unsafe(text, params)`                       | `fromUnsafeQuery(postgres(url))` |
| Prisma: `$queryRawUnsafe(text, ...params)`                | `fromVariadicQuery(prisma)`      |

Any other client or ORM works if you implement `PostgresClient`: a single `query(text, params)` method that returns rows.

### Prepared statements

`fromResultQuery(pool, { prepare: true })` (node-postgres) and `fromUnsafeQuery(sql, { prepare: true })` (postgres.js) reuse prepared statements, so Postgres skips query planning. In our benchmark this made a refresh about three times faster (0.46 ms to 0.14 ms on localhost).

Leave it off behind a connection pooler in transaction mode, such as PgBouncer before 1.21 or Supabase's port 6543: the next statement may run on a connection that never prepared it.

### Tables

`migrate(client, options?)` creates the tables and indexes if they are missing. Run it from one place, such as a deploy step, rather than from every instance at startup. To manage the schema with your own migration tool (Prisma, Drizzle, TypeORM, Flyway), use the SQL from `createSchemaSql(options?)` instead. Both are safe to run more than once.

| Table                             | Contents                                                                    |
| --------------------------------- | --------------------------------------------------------------------------- |
| `toklyn_sessions`                 | One row per session; claims and metadata as `jsonb`, times as `timestamptz` |
| `toklyn_refresh_tokens`           | SHA-256 hashes only; deleted with their session                             |
| `toklyn_access_token_revocations` | Denylisted access-token ids until they expire                               |

Expired rows are not removed automatically. Call `sessions.purgeExpired(Date.now())` and `revocations.purgeExpired()` from a scheduled job.

### Options

Both stores, `migrate` and `createSchemaSql` accept `schema` and `tablePrefix`. Use the same values everywhere, or queries fail with "relation does not exist".

| Option        | Default                                   | Description                                                                         |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `client`      | required (stores)                         | A `PostgresClient` from one of the adapters                                         |
| `schema`      | the connection's `search_path` (`public`) | Postgres schema for the tables; `migrate` creates it if missing                     |
| `tablePrefix` | `'toklyn_'`                               | Prefix for table and index names; up to 24 lowercase letters, digits or underscores |
| `clock`       | system clock                              | Revocation store only; inject time in tests                                         |

Names are validated and quoted, never taken from requests.

## MySQL and MariaDB

Clients: [`mysql2`](https://sidorares.github.io/node-mysql2/docs) (`mysql2/promise`) or [`mariadb`](https://github.com/mariadb-corporation/mariadb-connector-nodejs). Tested on MySQL 8.4 and MariaDB 11.

```ts
import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  fromTupleQuery,
  migrate,
} from '@toklyn/store/mysql';
import mysql from 'mysql2/promise';
import { createAuth } from 'toklyn';

const client = fromTupleQuery(mysql.createPool(process.env.DATABASE_URL!));
await migrate(client); // or put createSchemaSql() in your migrations

const auth = createAuth({
  // ...signer, verifier and lifetimes
  sessions: new MySqlSessionStore({ client }),
  revocations: new MySqlAccessTokenRevocationStore({ client }), // optional
});
```

MySQL cannot update and return rows in one statement, so rotation runs in a short transaction: `SELECT ... FOR UPDATE` locks the presented token and its session, then the token is consumed and its successor inserted. A concurrent refresh of the same token waits for the lock and then sees it consumed. Deadlocks and lock wait timeouts are retried up to three times.

Pick the adapter that matches your client:

| Client                                               | Adapter                 |
| ---------------------------------------------------- | ----------------------- |
| mysql2/promise: `query` resolves to `[rows, fields]` | `fromTupleQuery(pool)`  |
| mariadb: `query` resolves to the rows                | `fromDirectQuery(pool)` |

Pass a pool, not a single connection: each transaction takes its own connection. Any other client or ORM works if you implement `MySqlClient`: `query(sql, params)` returning `{ rows, affectedRows }`, and `transaction(fn)` that runs `fn` on one connection and rolls back if it throws.

The connection character set must be `utf8mb4` (the default for both clients).

### Prepared statements

`fromTupleQuery(pool, { prepare: true })` and `fromDirectQuery(pool, { prepare: true })` send statements through `execute`, which prepares each one once per connection. Leave it off behind a proxy that does not support prepared statements.

### Tables

`migrate(client, options?)` creates the tables if they are missing; the database itself must already exist. `createSchemaSql(options?)` returns the same DDL for your own migration tool. Both are safe to run more than once.

| Table                             | Contents                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `toklyn_sessions`                 | One row per session; claims and metadata as JSON text, times as `BIGINT` epoch ms |
| `toklyn_refresh_tokens`           | SHA-256 hashes only; deleted with their session                                   |
| `toklyn_access_token_revocations` | Denylisted access-token ids until they expire                                     |

Ids, subjects, hashes and token ids are `VARBINARY(255)`, so they compare byte for byte: no case folding and no trailing-space padding. Longer values are rejected with `invalid_input` instead of being truncated.

Expired rows are not removed automatically. Call `sessions.purgeExpired(Date.now())` and `revocations.purgeExpired()` from a scheduled job.

### Options

| Option        | Default                   | Description                                                               |
| ------------- | ------------------------- | ------------------------------------------------------------------------- |
| `client`      | required (stores)         | A `MySqlClient` from one of the adapters                                  |
| `database`    | the connection's database | Database holding the tables                                               |
| `tablePrefix` | `'toklyn_'`               | Prefix for table names; up to 24 lowercase letters, digits or underscores |
| `clock`       | system clock              | Revocation store only; inject time in tests                               |

The revocation store and `migrate` only need `query`, so any `MySqlExecutor` works there.

## SQLite

Clients: [`node:sqlite`](https://nodejs.org/api/sqlite.html) (built into Node 22.13+), [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), [`bun:sqlite`](https://bun.sh/docs/api/sqlite) or [`@libsql/client`](https://github.com/tursodatabase/libsql-client-ts) (libSQL and Turso). Each is tested on a real database, in memory and on disk.

```ts
import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromSyncDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import { DatabaseSync } from 'node:sqlite';
import { createAuth } from 'toklyn';

const db = new DatabaseSync('app.db');
db.exec('PRAGMA journal_mode = WAL');
const client = fromSyncDatabase(db);
await migrate(client); // or put createSchemaSql() in your migrations

const auth = createAuth({
  // ...signer, verifier and lifetimes
  sessions: new SqliteSessionStore({ client }),
  revocations: new SqliteAccessTokenRevocationStore({ client }), // optional
});
```

Rotation runs in a `BEGIN IMMEDIATE` transaction, which takes the database's write lock before reading the token. A concurrent refresh of the same token runs after it and sees the token consumed. When another connection holds the lock (`SQLITE_BUSY`), the store waits a few milliseconds and tries again, up to 10 times.

Pick the adapter that matches your client:

| Client                                                                   | Adapter                       |
| ------------------------------------------------------------------------ | ----------------------------- |
| `node:sqlite`, better-sqlite3, `bun:sqlite`: `prepare(sql).all()/.run()` | `fromSyncDatabase(db)`        |
| libSQL/Turso: `execute({ sql, args })` and `transaction('write')`        | `fromExecuteDatabase(client)` |

`fromSyncDatabase` runs the calls on one connection one at a time, so a transaction never mixes with other work on that connection. Any other client works if you implement `SqliteClient`: `all(sql, params)` returning rows, `run(sql, params)` returning the number of changed rows, and `transaction(fn)` that runs `fn` inside `BEGIN IMMEDIATE`.

Recommended setup:

- Turn on WAL mode (`PRAGMA journal_mode = WAL`) for a database file, so reads do not wait for writes.
- Open one connection (or one libSQL client) per database in each process. Several processes can share one file.
- With libSQL, use a file or Turso URL rather than `:memory:`, which has a single connection that a transaction holds.

### Tables

`migrate(client, options?)` creates the tables and indexes if they are missing, in one transaction. `createSchemaSql(options?)` returns the same DDL for your own migration tool. Both are safe to run more than once.

| Table                             | Contents                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `toklyn_sessions`                 | One row per session; claims and metadata as JSON text, times as `INTEGER` epoch ms |
| `toklyn_refresh_tokens`           | SHA-256 hashes only; `purgeExpired` deletes them with their session                |
| `toklyn_access_token_revocations` | Denylisted access-token ids until they expire                                      |

Tables are `STRICT`, so a value of the wrong type is rejected. Text compares byte for byte: no case folding and no trailing-space padding. The store does not need `PRAGMA foreign_keys`.

Expired rows are not removed automatically. Call `sessions.purgeExpired(Date.now())` and `revocations.purgeExpired()` from a scheduled job.

### Options

| Option        | Default           | Description                                                                         |
| ------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `client`      | required (stores) | A `SqliteClient` from one of the adapters                                           |
| `tablePrefix` | `'toklyn_'`       | Prefix for table and index names; up to 24 lowercase letters, digits or underscores |
| `clock`       | system clock      | Revocation store only; inject time in tests                                         |

The revocation store only needs `all` and `run`, so any `SqliteExecutor` works there.

## MongoDB

Client: the official [`mongodb`](https://www.mongodb.com/docs/drivers/node/current/) driver (v6+). With Mongoose, pass `mongoose.connection.db`. Tested on MongoDB 7.0 and 8.2.

```ts
import {
  MongoAccessTokenRevocationStore,
  MongoSessionStore,
  migrate,
} from '@toklyn/store/mongodb';
import { MongoClient } from 'mongodb';
import { createAuth } from 'toklyn';

const db = new MongoClient(process.env.MONGODB_URL!).db('app');
await migrate(db); // creates the indexes

const auth = createAuth({
  // ...signer, verifier and lifetimes
  sessions: new MongoSessionStore({ db }),
  revocations: new MongoAccessTokenRevocationStore({ db }), // optional
});
```

Each session is one document that also holds the hashes of its refresh tokens. Every change to a session checks and increments a version number on that document, so of two refreshes racing on the same token, only one write succeeds; the other reads the session again and sees the token used. A single-document update is atomic in MongoDB, so no transactions or replica set are needed.

The document keeps the hash of every refresh token the session has used, so reuse of any old token is caught. It grows by about 220 bytes per refresh: a 30-day session refreshed every 15 minutes reaches about 620 KB, well under MongoDB's 16 MB document limit.

### Collections

`migrate(db, options?)` creates the indexes the stores rely on, including a unique index on refresh-token hashes. Run it once, such as in a deploy step. It is safe to run more than once.

| Collection                        | Contents                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `toklyn_sessions`                 | One document per session; claims and metadata as JSON text, times as epoch ms, token hashes |
| `toklyn_access_token_revocations` | Denylisted access-token ids until they expire                                               |

Claims are stored as JSON text, so keys such as `$where` or `a.b` round-trip unchanged and never act as query operators. Ids, subjects and hashes must be strings; anything else is rejected with `invalid_input`.

Expired documents are deleted by MongoDB itself (TTL indexes, checked about once a minute), so no cleanup job is needed. `purgeExpired` is still there if you want to delete them right away.

### Options

| Option             | Default      | Description                                                                    |
| ------------------ | ------------ | ------------------------------------------------------------------------------ |
| `db`               | required     | A database handle (`client.db(name)`)                                          |
| `collectionPrefix` | `'toklyn_'`  | Prefix for collection names; up to 24 lowercase letters, digits or underscores |
| `clock`            | system clock | Revocation store only; inject time in tests                                    |

## Redis

Clients: [`ioredis`](https://github.com/redis/ioredis), [`redis`](https://github.com/redis/node-redis) (node-redis) or [`@upstash/redis`](https://github.com/upstash/redis-js).

```ts
import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromVariadicEval,
} from '@toklyn/store/redis';
import { Redis } from 'ioredis';
import { createAuth } from 'toklyn';

const client = fromVariadicEval(
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
);

const auth = createAuth({
  // ...signer, verifier and lifetimes
  sessions: new RedisSessionStore({ client }),
  revocations: new RedisAccessTokenRevocationStore({ client }), // optional
});
```

Every operation is a single Lua script. Keys expire together with their session, so no cleanup job is needed. All keys of a store share one hash slot, so it works on Redis Cluster.

Pick the adapter that matches your client's `eval` signature:

| Client                                           | Adapter                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| ioredis: `eval(script, numKeys, ...keysAndArgs)` | `fromVariadicEval(new Redis(url))`                                          |
| node-redis: `eval(script, { keys, arguments })`  | `fromOptionsEval(await createClient({ url }).connect())`                    |
| Upstash: `eval(script, keys, args)`              | `fromArrayEval(new Redis({ url, token, automaticDeserialization: false }))` |

Upstash needs `automaticDeserialization: false` so replies stay strings. Any other client works if you implement `RedisClient`: a single `eval(script, keys, args)` method.

### Options

| `RedisSessionStore` | Default       | Description                                                                                                                                             |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`            | required      | A `RedisClient` from one of the adapters                                                                                                                |
| `keyPrefix`         | `'{toklyn}:'` | Prefix for all keys. The braces are a Cluster hash tag that keeps every key in one slot, which the scripts require; keep a `{...}` tag if you change it |

| `RedisAccessTokenRevocationStore` | Default       | Description          |
| --------------------------------- | ------------- | -------------------- |
| `client`                          | required      | A `RedisClient`      |
| `keyPrefix`                       | `'{toklyn}:'` | As above             |
| `clock`                           | system clock  | Inject time in tests |

## Examples with drivers and ORMs

[`examples/stores`](https://github.com/singhgulshan/toklyn/tree/main/examples/stores) wires each store to the connection your app already has. Each file is short enough to copy, and CI runs each one (all but Upstash, which needs an account) against a real database: sign in, refresh, reuse detection, 10 parallel refreshes of one token (exactly one wins), access token revocation and "sign out other devices".

| Database      | Drivers                                                                                                                                                                                                                                                                                                                     | ORMs and query builders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL    | [pg](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/pg.ts), [postgres.js](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/postgres-js.ts)                                                                                                                      | [Prisma](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/prisma.ts), [Drizzle](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/drizzle.ts), [TypeORM](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/typeorm.ts), [Sequelize](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/sequelize.ts), [Knex](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/knex.ts), [Kysely](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/postgres/kysely.ts) |
| MySQL/MariaDB | [mysql2](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/mysql2.ts), [mariadb](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/mariadb.ts)                                                                                                                            | [Prisma](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/prisma.ts), [Drizzle](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/drizzle.ts), [TypeORM](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/typeorm.ts), [Sequelize](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/sequelize.ts), [Knex](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/knex.ts), [Kysely](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mysql/kysely.ts)                   |
| SQLite        | [node:sqlite](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/sqlite/node-sqlite.ts), [better-sqlite3](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/sqlite/better-sqlite3.ts), [libSQL](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/sqlite/libsql.ts) | [Drizzle](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/sqlite/drizzle.ts), [Knex](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/sqlite/knex.ts), [Kysely](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/sqlite/kysely.ts)                                                                                                                                                                                                                                                                                                                        |
| MongoDB       | [mongodb](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mongodb/mongodb.ts)                                                                                                                                                                                                                          | [Mongoose](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/mongodb/mongoose.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Redis         | [ioredis](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/redis/ioredis.ts), [node-redis](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/redis/node-redis.ts), [Upstash](https://github.com/singhgulshan/toklyn/blob/main/examples/stores/src/redis/upstash.ts)                  | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

- **Drivers** use the adapters above (`fromResultQuery`, `fromTupleQuery`, `fromSyncDatabase`, ...).
- **Drizzle** and **Mongoose** hand you the driver they wrap (`db.$client`, `mongoose.connection.db`), so the driver adapters work as is.
- **Prisma, TypeORM, Sequelize, Knex and Kysely** need a few lines that run SQL through the ORM's raw-query API, always with bound parameters. For MySQL and SQLite, `transaction` must use the ORM's transaction so rotation runs on one connection, and MySQL deadlock errors must keep the driver's `errno` so the store can retry.

## Notes

- Session claims are stored as JSON, so they must be JSON-serializable.
- An unexpected reply from the database fails with `storage_error`; it never passes as a valid token.
- Moving from `@toklyn/redis`: install `@toklyn/store` and import from `@toklyn/store/redis`. Class names, options and stored keys are unchanged, so existing sessions keep working.

## Links

- [Full documentation](https://github.com/singhgulshan/toklyn#readme)
- [Storage overview and custom stores](https://github.com/singhgulshan/toklyn#storage)
- [Verification modes and revocation](https://github.com/singhgulshan/toklyn#verification-modes)

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
