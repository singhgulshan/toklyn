import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromOptionsEval,
} from '@toklyn/store/redis';
import { createClient } from 'redis';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const redis = createClient({ url: env('REDIS_URL') });
  await redis.connect();
  // No migration: keys are created on write and expire with their session.
  const client = fromOptionsEval(redis);

  return {
    sessions: new RedisSessionStore({ client }),
    revocations: new RedisAccessTokenRevocationStore({ client }),
    close: async () => {
      await redis.close();
    },
  };
}
