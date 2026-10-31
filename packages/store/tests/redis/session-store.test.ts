import { ToklynError } from 'toklyn';
import type { NewSession, Session } from 'toklyn';
import { sessionStoreContract } from 'toklyn/testing';
import { describe, expect, it } from 'vitest';
import {
  RedisSessionStore,
  fromOptionsEval,
  fromVariadicEval,
} from '#src/redis/index.js';
import { useRedis } from './redis.js';

const redis = useRedis();
const T0 = 1_000_000;
const HOUR = 3_600_000;

sessionStoreContract(
  'RedisSessionStore (ioredis)',
  () =>
    new RedisSessionStore({
      client: fromVariadicEval(redis.io),
      keyPrefix: redis.prefix(),
    }),
);

sessionStoreContract(
  'RedisSessionStore (node-redis)',
  () =>
    new RedisSessionStore({
      client: fromOptionsEval(redis.node),
      keyPrefix: redis.prefix(),
    }),
);

function newSession(overrides: Partial<Session> = {}): NewSession {
  const session: Session = {
    id: 'session-1',
    subject: 'user-1',
    claims: { role: 'admin' },
    metadata: {},
    createdAt: T0,
    lastRefreshedAt: T0,
    expiresAt: T0 + 2 * HOUR,
    revokedAt: null,
    ...overrides,
  };
  return {
    session,
    refreshToken: {
      hash: 'hash-1',
      sessionId: session.id,
      issuedAt: T0,
      expiresAt: T0 + HOUR,
      consumedAt: null,
    },
  };
}

describe('RedisSessionStore', () => {
  function setup() {
    const keyPrefix = redis.prefix();
    const store = new RedisSessionStore({
      client: fromVariadicEval(redis.io),
      keyPrefix,
    });
    return { store, keyPrefix };
  }

  it('round-trips claims with empty arrays and nested objects', async () => {
    const { store } = setup();
    const claims = {
      roles: [],
      scopes: ['read'],
      org: { id: 'o-1', tags: [] },
    };
    await store.create(newSession({ claims }));

    expect((await store.find('session-1'))?.claims).toEqual(claims);

    const result = await store.rotate({
      presentedHash: 'hash-1',
      newHash: 'hash-2',
      now: T0 + 1000,
      refreshTtlMs: HOUR,
      reuseGraceMs: 0,
      claims: { roles: [] },
    });
    expect(result.status === 'rotated' && result.session.claims).toEqual({
      roles: [],
    });
  });

  it('expires every key together with the session', async () => {
    const { store, keyPrefix } = setup();
    await store.create(newSession());
    await store.rotate({
      presentedHash: 'hash-1',
      newHash: 'hash-2',
      now: T0 + 1000,
      refreshTtlMs: HOUR,
      reuseGraceMs: 0,
    });

    for (const key of ['s:session-1', 't:hash-1', 't:hash-2', 'u:user-1']) {
      const ttl = await redis.io.pttl(`${keyPrefix}${key}`);
      expect(ttl).toBeGreaterThan(2 * HOUR - 60_000);
      expect(ttl).toBeLessThanOrEqual(2 * HOUR);
    }
  });

  it('refuses to overwrite an existing token hash on rotate', async () => {
    const { store } = setup();
    await store.create(newSession());
    await store.create({
      ...newSession({ id: 'session-2' }),
      refreshToken: {
        ...newSession().refreshToken,
        hash: 'taken',
        sessionId: 'session-2',
      },
    });

    await expect(
      store.rotate({
        presentedHash: 'hash-1',
        newHash: 'taken',
        now: T0 + 1000,
        refreshTtlMs: HOUR,
        reuseGraceMs: 0,
      }),
    ).rejects.toThrow();
    expect(
      (
        await store.rotate({
          presentedHash: 'hash-1',
          newHash: 'hash-2',
          now: T0 + 2000,
          refreshTtlMs: HOUR,
          reuseGraceMs: 0,
        })
      ).status,
    ).toBe('rotated');
  });

  it('drops ids of evicted sessions from the subject index', async () => {
    const { store, keyPrefix } = setup();
    await store.create(newSession());
    await redis.io.del(`${keyPrefix}s:session-1`);

    expect(await store.listForSubject('user-1', T0)).toEqual([]);
    expect(await redis.io.smembers(`${keyPrefix}u:user-1`)).toEqual([]);
  });

  it('reads sessions written without lastRefreshedAt (0.1.0)', async () => {
    const { store, keyPrefix } = setup();
    await store.create(newSession());
    await redis.io.hdel(`${keyPrefix}s:session-1`, 'lastRefreshedAt');

    expect((await store.find('session-1'))?.lastRefreshedAt).toBe(T0);

    await store.rotate({
      presentedHash: 'hash-1',
      newHash: 'hash-2',
      now: T0 + 1000,
      refreshTtlMs: HOUR,
      reuseGraceMs: 0,
    });
    expect((await store.find('session-1'))?.lastRefreshedAt).toBe(T0 + 1000);
  });

  it('reports a malformed reply as a storage error', async () => {
    const store = new RedisSessionStore({
      client: { eval: async () => ['id', 'session-1'] },
    });

    const error = await store.find('session-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToklynError);
    expect((error as ToklynError).code).toBe('storage_error');
  });
});
