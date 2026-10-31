# @toklyn/redis

**Redis session and access-token revocation stores for [toklyn](https://github.com/singhgulshan/toklyn).**

[![npm](https://img.shields.io/npm/v/@toklyn/redis?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/redis)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

Every operation is a single Lua script, so refresh-token rotation is atomic across all your server instances. Keys expire together with their session, so no cleanup job is needed.

Tested against Redis with ioredis and node-redis. Built for Redis 6.2 or later, Valkey, Upstash and Redis Cluster (all keys of a store share one hash slot).

## Install

```sh
npm install toklyn @toklyn/redis
```

Bring your own client: [`ioredis`](https://github.com/redis/ioredis), [`redis`](https://github.com/redis/node-redis) (node-redis) or [`@upstash/redis`](https://github.com/upstash/redis-js).

## Usage

```ts
import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromVariadicEval,
} from '@toklyn/redis';
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

Pick the adapter that matches your client's `eval` signature:

| Client                                           | Adapter                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| ioredis: `eval(script, numKeys, ...keysAndArgs)` | `fromVariadicEval(new Redis(url))`                                          |
| node-redis: `eval(script, { keys, arguments })`  | `fromOptionsEval(await createClient({ url }).connect())`                    |
| Upstash: `eval(script, keys, args)`              | `fromArrayEval(new Redis({ url, token, automaticDeserialization: false }))` |

Upstash needs `automaticDeserialization: false` so replies stay strings. Any other client works if you implement `RedisClient` (a single `eval(script, keys, args)` method).

## Options

| `RedisSessionStore` | Default       | Description                                                                                                                                             |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`            | required      | A `RedisClient` from one of the adapters                                                                                                                |
| `keyPrefix`         | `'{toklyn}:'` | Prefix for all keys. The braces are a Cluster hash tag that keeps every key in one slot, which the scripts require; keep a `{...}` tag if you change it |

| `RedisAccessTokenRevocationStore` | Default       | Description          |
| --------------------------------- | ------------- | -------------------- |
| `client`                          | required      | A `RedisClient`      |
| `keyPrefix`                       | `'{toklyn}:'` | As above             |
| `clock`                           | system clock  | Inject time in tests |

Session claims are stored as JSON, so they must be JSON-serializable.

## Links

- [Full documentation](https://github.com/singhgulshan/toklyn#readme)
- [Storage overview and custom stores](https://github.com/singhgulshan/toklyn#storage)
- [Verification modes and revocation](https://github.com/singhgulshan/toklyn#verification-modes)

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
