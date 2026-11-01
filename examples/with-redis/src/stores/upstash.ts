import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromArrayEval,
} from '@toklyn/store/redis';
import { Redis } from '@upstash/redis';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const redis = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
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
