import type { NewSession, Session } from 'toklyn';
import { revocationStoreContract, sessionStoreContract } from 'toklyn/testing';
import { describe, expect, it } from 'vitest';
import {
  MongoAccessTokenRevocationStore,
  MongoSessionStore,
} from '#src/mongodb/index.js';
import { MONGODB_URL, lazyRevocationStore, useMongo } from './mongodb.js';

const T0 = 1_700_000_000_123;
const HOUR = 3_600_000;

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

if (MONGODB_URL) {
  const mongo = useMongo(MONGODB_URL);
  const store = async () =>
    new MongoSessionStore({
      db: mongo.db,
      collectionPrefix: await mongo.freshPrefix(),
    });

  sessionStoreContract('MongoSessionStore', store);
  revocationStoreContract('MongoAccessTokenRevocationStore', (clock) =>
    lazyRevocationStore(
      async () =>
        new MongoAccessTokenRevocationStore({
          db: mongo.db,
          collectionPrefix: await mongo.freshPrefix(),
          clock,
        }),
    ),
  );

  describe('concurrent rotation on MongoDB', () => {
    async function race(reuseGraceMs: number) {
      const s = await store();
      await s.create(newSession());
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          s.rotate({
            presentedHash: 'hash-1',
            newHash: `hash-next-${i}`,
            now: T0 + 1000,
            refreshTtlMs: HOUR,
            reuseGraceMs,
          }),
        ),
      );
      return results.map((r) => r.status);
    }

    it('lets exactly one of many rotations win without a grace window', async () => {
      const statuses = await race(0);

      expect(statuses.filter((s) => s === 'rotated')).toHaveLength(1);
      expect(
        statuses.every((s) =>
          ['rotated', 'reuse_detected', 'session_revoked'].includes(s),
        ),
      ).toBe(true);
    });

    it('lets all of them win inside the grace window', async () => {
      const statuses = await race(10_000);

      expect(statuses.every((s) => s === 'rotated')).toBe(true);
    });
  });

  describe('MongoSessionStore on MongoDB', () => {
    it('round-trips claims with empty arrays, nested objects, operator-like keys and non-ASCII text', async () => {
      const s = await store();
      const claims = {
        roles: [],
        name: 'Zoë 🙂',
        org: { id: 'o-1', tags: [] },
        $where: 'stored as text',
        'a.b': 1,
      };
      await s.create(newSession({ claims, subject: 'ユーザー' }));

      expect((await s.find('session-1'))?.claims).toEqual(claims);
      expect(await s.listForSubject('ユーザー', T0)).toHaveLength(1);
    });

    it('keeps millisecond timestamps exact', async () => {
      const s = await store();
      const session = newSession({
        createdAt: T0 + 1,
        lastRefreshedAt: T0 + 999,
        expiresAt: 8_640_000_000_000_000 - 7,
        revokedAt: T0 + 5,
      });
      await s.create(session);

      expect(await s.find('session-1')).toEqual(session.session);
    });

    it('compares subjects and ids exactly: no case folding or trailing spaces', async () => {
      const s = await store();
      await s.create(newSession());

      expect(await s.listForSubject('USER-1', T0)).toEqual([]);
      expect(await s.listForSubject('user-1 ', T0)).toEqual([]);
      expect(await s.find('SESSION-1')).toBeNull();
      expect(await s.revokeAllForSubject('User-1', T0)).toEqual([]);
    });

    it('rejects a token hash that already exists in another session', async () => {
      const s = await store();
      await s.create(newSession());

      await expect(s.create(newSession({ id: 'session-2' }))).rejects.toThrow();
      expect(await s.find('session-2')).toBeNull();
    });

    it('rejects non-string input instead of treating it as a query operator', async () => {
      const s = await store();
      await s.create(newSession());
      const operator = { $ne: null } as unknown as string;

      await expect(s.find(operator)).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(s.listForSubject(operator, T0)).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(
        s.rotate({
          presentedHash: operator,
          newHash: 'x',
          now: T0,
          refreshTtlMs: HOUR,
          reuseGraceMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('rejects a malformed stored document with storage_error', async () => {
      const prefix = await mongo.freshPrefix();
      await mongo.db
        .collection(`${prefix}sessions`)
        .insertOne({ _id: 'bad' as never, subject: 'user-1', claims: 7 });

      await expect(
        new MongoSessionStore({ db: mongo.db, collectionPrefix: prefix }).find(
          'bad',
        ),
      ).rejects.toMatchObject({ code: 'storage_error' });
    });
  });
} else {
  it.skip('MongoDB server (set MONGODB_URL)', () => {});
}
