# @toklyn/postgres

**PostgreSQL session and access-token revocation stores for [toklyn](https://github.com/singhgulshan/toklyn).**

[![npm](https://img.shields.io/npm/v/@toklyn/postgres?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/postgres)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

Every operation is a single SQL statement, so refresh-token rotation is atomic across all your server instances without transactions. Row locks cover only the session being refreshed.

Tested on PostgreSQL 17 and 18 with node-postgres, postgres.js and PGlite.

## Install

```sh
npm install toklyn @toklyn/postgres
```

Bring your own client: [`pg`](https://node-postgres.com) (node-postgres), [`postgres`](https://github.com/porsager/postgres) (postgres.js), [`@electric-sql/pglite`](https://pglite.dev), [`@neondatabase/serverless`](https://github.com/neondatabase/serverless) `Pool` or Prisma.

## Usage

```ts
import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromResultQuery,
  migrate,
} from '@toklyn/postgres';
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

Pick the adapter that matches your client:

| Client                                                     | Adapter                                      |
| ---------------------------------------------------------- | -------------------------------------------- |
| node-postgres, PGlite, Neon `Pool`: `query(text, params)`  | `fromResultQuery(pool)`                      |
| postgres.js: `unsafe(text, params)`                        | `fromUnsafeQuery(postgres(url))`             |
| Prisma: `$queryRawUnsafe(text, ...params)`                 | `fromVariadicQuery(prisma)`                  |

Any other client works if you implement `PostgresClient` (a single `query(text, params)` method that returns rows).

### Prepared statements

`fromResultQuery(pool, { prepare: true })` (node-postgres) and `fromUnsafeQuery(sql, { prepare: true })` (postgres.js) reuse prepared statements, so Postgres skips query planning. In our benchmark this made a refresh about three times faster (0.46 ms to 0.14 ms on localhost).

Leave it off behind a connection pooler in transaction mode, such as PgBouncer before 1.21 or Supabase's port 6543: the next statement may run on a connection that never prepared it.

## Tables

`migrate(client, options?)` creates the tables and indexes if they are missing. Run it from one place, such as a deploy step, rather than from every instance at startup. To manage the schema with your own migration tool (Prisma, Drizzle, TypeORM, Flyway), use the SQL from `createSchemaSql(options?)` instead. Both are safe to run more than once.

| Table                              | Contents                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `toklyn_sessions`                  | One row per session; claims and metadata as `jsonb`, times as `timestamptz` |
| `toklyn_refresh_tokens`            | SHA-256 hashes only; deleted with their session                             |
| `toklyn_access_token_revocations`  | Denylisted access-token ids until they expire                               |

Expired rows are not removed automatically. Call `sessions.purgeExpired(Date.now())` and `revocations.purgeExpired()` from a scheduled job.

## Options

Both stores, `migrate` and `createSchemaSql` accept `schema` and `tablePrefix`. Use the same values everywhere, or queries fail with "relation does not exist".

| Option        | Default                                 | Description                                                                         |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `client`      | required (stores)                       | A `PostgresClient` from one of the adapters                                         |
| `schema`      | the connection's `search_path` (`public`) | Postgres schema for the tables; `migrate` creates it if missing                   |
| `tablePrefix` | `'toklyn_'`                             | Prefix for table and index names; up to 24 lowercase letters, digits or underscores |
| `clock`       | system clock                            | Revocation store only; inject time in tests                                         |

Names are validated and quoted, never taken from requests. Session claims are stored as JSON, so they must be JSON-serializable.

## Links

- [Full documentation](https://github.com/singhgulshan/toklyn#readme)
- [Storage overview and custom stores](https://github.com/singhgulshan/toklyn#storage)
- [Verification modes and revocation](https://github.com/singhgulshan/toklyn#verification-modes)

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
