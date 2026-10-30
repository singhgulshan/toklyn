import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll } from 'vitest';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** Connects both clients for the current test file and deletes its keys afterwards. */
export function useRedis() {
  const tag = `toklyn-test-${randomUUID()}`;
  let counter = 0;
  const io = new Redis(REDIS_URL, { lazyConnect: true });
  const node = createClient({ url: REDIS_URL });

  beforeAll(async () => {
    await Promise.all([io.connect(), node.connect()]);
  });

  afterAll(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await io.scan(
        cursor,
        'MATCH',
        `{${tag}-*`,
        'COUNT',
        1000,
      );
      if (keys.length > 0) await io.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    io.disconnect();
    node.destroy();
  });

  return {
    io,
    node,
    /** A fresh hash-tagged prefix, so every store starts empty. */
    prefix: () => {
      counter += 1;
      return `{${tag}-${counter}}:`;
    },
  };
}
