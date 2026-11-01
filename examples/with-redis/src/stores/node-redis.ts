import {
  RedisAccessTokenRevocationStore,
  RedisSessionStore,
  fromOptionsEval,
} from '@toklyn/store/redis';
import { createClient } from 'redis';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const redis = createClient({ url: requireEnv('REDIS_URL') });
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
