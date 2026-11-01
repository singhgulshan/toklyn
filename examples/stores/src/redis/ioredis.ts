import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromVariadicEval,
} from '@toklyn/store/redis';
import { Redis } from 'ioredis';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const redis = new Redis(env('REDIS_URL'));
  // No migration: keys are created on write and expire with their session.
  const client = fromVariadicEval(redis);

  return {
    sessions: new RedisSessionStore({ client }),
    revocations: new RedisAccessTokenRevocationStore({ client }),
    close: async () => {
      await redis.quit();
    },
  };
}
