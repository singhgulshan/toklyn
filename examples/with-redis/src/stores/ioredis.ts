import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromVariadicEval,
} from '@toklyn/store/redis';
import { Redis } from 'ioredis';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const redis = new Redis(requireEnv('REDIS_URL'));
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
