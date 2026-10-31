import { revocationStoreContract } from 'toklyn/testing';
import { describe, expect, it } from 'vitest';
import {
  RedisAccessTokenRevocationStore,
  fromVariadicEval,
} from '#src/redis/index.js';
import { useRedis } from './redis.js';

const redis = useRedis();

revocationStoreContract(
  'RedisAccessTokenRevocationStore',
  (clock) =>
    new RedisAccessTokenRevocationStore({
      client: fromVariadicEval(redis.io),
      keyPrefix: redis.prefix(),
      clock,
    }),
);

describe('RedisAccessTokenRevocationStore', () => {
  const clock = { now: () => 1_000_000 };

  it('lets Redis drop the entry when the token expires', async () => {
    const keyPrefix = redis.prefix();
    const store = new RedisAccessTokenRevocationStore({
      client: fromVariadicEval(redis.io),
      keyPrefix,
      clock,
    });

    await store.revoke('jti-1', clock.now() + 60_000);

    const ttl = await redis.io.pttl(`${keyPrefix}r:jti-1`);
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('keeps the later expiry when revoked twice', async () => {
    const keyPrefix = redis.prefix();
    const store = new RedisAccessTokenRevocationStore({
      client: fromVariadicEval(redis.io),
      keyPrefix,
      clock,
    });

    await store.revoke('jti-1', clock.now() + 60_000);
    await store.revoke('jti-1', clock.now() + 1_000);

    expect(await redis.io.get(`${keyPrefix}r:jti-1`)).toBe(
      String(clock.now() + 60_000),
    );
  });
});
