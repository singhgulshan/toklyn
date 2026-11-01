import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromArrayEval,
} from '@toklyn/store/redis';
import { Redis } from '@upstash/redis';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const redis = new Redis({
    url: env('UPSTASH_REDIS_REST_URL'),
    token: env('UPSTASH_REDIS_REST_TOKEN'),
    // The stores parse Redis replies themselves.
    automaticDeserialization: false,
  });
  const client = fromArrayEval(redis);

  return {
    sessions: new RedisSessionStore({ client }),
    revocations: new RedisAccessTokenRevocationStore({ client }),
    // Upstash talks HTTP, so there is no connection to close.
    close: async () => {},
  };
}
