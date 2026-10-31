# @toklyn/store

**PostgreSQL and Redis session and access-token revocation stores for [toklyn](https://github.com/singhgulshan/toklyn).**

[![npm](https://img.shields.io/npm/v/@toklyn/store?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/store)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

One package, one import path per database. Each store is written natively for its database, so refresh-token rotation is atomic across all your server instances, and an app only loads the database it imports.

| Import                   | Database                                       | Atomic rotation   |
| ------------------------ | ---------------------------------------------- | ----------------- |
| `@toklyn/store/postgres` | PostgreSQL (tested on 17 and 18), PGlite, Neon | One SQL statement |
| `@toklyn/store/redis`    | Redis 6.2+, Valkey, Upstash, Redis Cluster     | One Lua script    |

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
