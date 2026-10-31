import { describe, expect, it } from 'vitest';
import type { RotateInput, SessionStore } from '#src/contracts.js';
import type { RefreshTokenRecord, Session } from '#src/types.js';

const T0 = 1_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SESSION_LIFETIME = 24 * HOUR;
const REFRESH_TTL = 7 * HOUR;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    subject: 'user-1',
    claims: { role: 'admin' },
    metadata: { userAgent: 'test' },
    createdAt: T0,
    lastRefreshedAt: T0,
    expiresAt: T0 + SESSION_LIFETIME,
    revokedAt: null,
    ...overrides,
  };
}

function makeToken(
  hash: string,
  session: Session,
  overrides: Partial<RefreshTokenRecord> = {},
): RefreshTokenRecord {
  return {
    hash,
    sessionId: session.id,
    issuedAt: T0,
    expiresAt: T0 + REFRESH_TTL,
    consumedAt: null,
    ...overrides,
  };
}

function rotateInput(overrides: Partial<RotateInput> = {}): RotateInput {
  return {
    presentedHash: 'hash-1',
    newHash: 'hash-2',
    now: T0 + MINUTE,
    refreshTtlMs: REFRESH_TTL,
    reuseGraceMs: 0,
    ...overrides,
  };
}

/** Every SessionStore implementation must pass this suite unchanged. */
export function sessionStoreContract(
  name: string,
  createStore: () => SessionStore | Promise<SessionStore>,
): void {
  describe(`${name} satisfies the SessionStore contract`, () => {
    async function seed(
      overrides: Partial<Session> = {},
      tokenOverrides: Partial<RefreshTokenRecord> = {},
      hash = 'hash-1',
    ) {
      const store = await createStore();
      const session = makeSession(overrides);
      await store.create({
        session,
        refreshToken: makeToken(hash, session, tokenOverrides),
      });
      return { store, session };
    }

    describe('create and find', () => {
      it('returns the stored session', async () => {
        const { store, session } = await seed();

        expect(await store.find(session.id)).toEqual(session);
      });

      it('returns null for an unknown session', async () => {
        const store = await createStore();

        expect(await store.find('missing')).toBeNull();
      });

      it('rejects a duplicate session id', async () => {
        const { store, session } = await seed();

        await expect(
          store.create({
            session,
            refreshToken: makeToken('hash-other', session),
          }),
        ).rejects.toThrow();
      });

      it('does not alias the object it was given', async () => {
        const { store, session } = await seed();
        const found = await store.find(session.id);

        (found as Session).revokedAt = 123;

        expect((await store.find(session.id))?.revokedAt).toBeNull();
      });
    });

    describe('rotate', () => {
      it('consumes the presented token and stores its successor', async () => {
        const { store, session } = await seed();
        const now = T0 + MINUTE;

        const result = await store.rotate(rotateInput({ now }));

        expect(result.status).toBe('rotated');
        if (result.status !== 'rotated') return;
        expect(result.session.id).toBe(session.id);
        expect(result.refreshToken).toEqual({
          hash: 'hash-2',
          sessionId: session.id,
          issuedAt: now,
          expiresAt: now + REFRESH_TTL,
          consumedAt: null,
        });
      });

      it('lets the successor be rotated in turn', async () => {
        const { store } = await seed();
        await store.rotate(rotateInput());

        const result = await store.rotate(
          rotateInput({
            presentedHash: 'hash-2',
            newHash: 'hash-3',
            now: T0 + 2 * MINUTE,
          }),
        );

        expect(result.status).toBe('rotated');
      });

      it('never lets a successor outlive the session', async () => {
        const { store, session } = await seed({ expiresAt: T0 + 2 * HOUR });
        const now = T0 + 90 * MINUTE;

        const result = await store.rotate(
          rotateInput({ now, refreshTtlMs: 5 * HOUR }),
        );

        expect(result.status).toBe('rotated');
        if (result.status !== 'rotated') return;
        expect(result.refreshToken.expiresAt).toBe(session.expiresAt);
      });

      it('replaces the session claims when new claims are supplied', async () => {
        const { store, session } = await seed();

        const result = await store.rotate(
          rotateInput({ claims: { role: 'viewer' } }),
        );

        expect(result.status).toBe('rotated');
        if (result.status !== 'rotated') return;
        expect(result.session.claims).toEqual({ role: 'viewer' });
        expect((await store.find(session.id))?.claims).toEqual({
          role: 'viewer',
        });
      });

      it('keeps the session claims when none are supplied', async () => {
        const { store, session } = await seed();

        await store.rotate(rotateInput());

        expect((await store.find(session.id))?.claims).toEqual(session.claims);
      });

      it('leaves the claims alone when the rotation is refused', async () => {
        const { store, session } = await seed();
        await store.rotate(rotateInput());

        const reuse = await store.rotate(
          rotateInput({ newHash: 'hash-3', claims: { role: 'attacker' } }),
        );

        expect(reuse.status).toBe('reuse_detected');
        expect((await store.find(session.id))?.claims).toEqual(session.claims);
      });

      it('reports an unknown token without touching the session', async () => {
        const { store, session } = await seed();

        const result = await store.rotate(
          rotateInput({ presentedHash: 'never-issued' }),
        );

        expect(result).toEqual({ status: 'unknown_token' });
        expect((await store.find(session.id))?.revokedAt).toBeNull();
        expect((await store.rotate(rotateInput())).status).toBe('rotated');
      });

      it('rejects an expired refresh token', async () => {
        const { store } = await seed({}, { expiresAt: T0 + 5 * MINUTE });

        const result = await store.rotate(
          rotateInput({ now: T0 + 6 * MINUTE }),
        );

        expect(result.status).toBe('token_expired');
      });

      it('rejects a token of an expired session', async () => {
        const { store } = await seed({ expiresAt: T0 + 5 * MINUTE });

        const result = await store.rotate(
          rotateInput({ now: T0 + 5 * MINUTE }),
        );

        expect(result.status).toBe('session_expired');
      });

      it('rejects a token of a revoked session', async () => {
        const { store, session } = await seed();
        await store.revoke(session.id, T0 + 30_000);

        const result = await store.rotate(rotateInput());

        expect(result.status).toBe('session_revoked');
      });
    });

    describe('lastRefreshedAt', () => {
      it('records the time of a successful rotation', async () => {
        const { store, session } = await seed();
        const now = T0 + MINUTE;

        const result = await store.rotate(rotateInput({ now }));

        expect(result.status).toBe('rotated');
        if (result.status !== 'rotated') return;
        expect(result.session.lastRefreshedAt).toBe(now);
        expect((await store.find(session.id))?.lastRefreshedAt).toBe(now);
      });

      it('records a rotation inside the reuse grace window', async () => {
        const { store, session } = await seed();
        await store.rotate(rotateInput({ now: T0 + MINUTE }));
        const now = T0 + MINUTE + 5_000;

        await store.rotate(
          rotateInput({ newHash: 'hash-3', now, reuseGraceMs: 10_000 }),
        );

        expect((await store.find(session.id))?.lastRefreshedAt).toBe(now);
      });

      it('is left alone when the rotation is refused', async () => {
        const { store, session } = await seed();
        await store.rotate(rotateInput({ now: T0 + MINUTE }));

        await store.rotate(
          rotateInput({ newHash: 'hash-3', now: T0 + 2 * MINUTE }),
        );
        await store.rotate(
          rotateInput({ presentedHash: 'never-issued', now: T0 + 3 * MINUTE }),
        );

        expect((await store.find(session.id))?.lastRefreshedAt).toBe(
          T0 + MINUTE,
        );
      });
    });

    describe('reuse detection', () => {
      it('revokes the session when a consumed token is presented again', async () => {
        const { store, session } = await seed();
        await store.rotate(rotateInput());

        const reuse = await store.rotate(
          rotateInput({ newHash: 'hash-3', now: T0 + 2 * MINUTE }),
        );

        expect(reuse.status).toBe('reuse_detected');
        if (reuse.status !== 'reuse_detected') return;
        expect(reuse.session.revokedAt).toBe(T0 + 2 * MINUTE);
        expect((await store.find(session.id))?.revokedAt).toBe(T0 + 2 * MINUTE);
      });

      it('invalidates the successor token once reuse is detected', async () => {
        const { store } = await seed();
        await store.rotate(rotateInput());
        await store.rotate(
          rotateInput({ newHash: 'hash-3', now: T0 + 2 * MINUTE }),
        );

        const result = await store.rotate(
          rotateInput({
            presentedHash: 'hash-2',
            newHash: 'hash-4',
            now: T0 + 3 * MINUTE,
          }),
        );

        expect(result.status).toBe('session_revoked');
      });

      it('still detects reuse after several later rotations', async () => {
        const { store } = await seed();
        await store.rotate(rotateInput());
        await store.rotate(
          rotateInput({
            presentedHash: 'hash-2',
            newHash: 'hash-3',
            now: T0 + 2 * MINUTE,
          }),
        );

        const reuse = await store.rotate(
          rotateInput({ newHash: 'hash-4', now: T0 + 3 * MINUTE }),
        );

        expect(reuse.status).toBe('reuse_detected');
      });

      it('lets only one of two concurrent rotations succeed', async () => {
        const { store } = await seed();

        const results = await Promise.all([
          store.rotate(rotateInput({ newHash: 'hash-a' })),
          store.rotate(rotateInput({ newHash: 'hash-b' })),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([
          'reuse_detected',
          'rotated',
        ]);
      });
    });

    describe('reuse grace window', () => {
      it('accepts a consumed token again inside the window', async () => {
        const { store, session } = await seed();
        await store.rotate(rotateInput({ now: T0 + MINUTE }));

        const again = await store.rotate(
          rotateInput({
            newHash: 'hash-3',
            now: T0 + MINUTE + 5_000,
            reuseGraceMs: 10_000,
          }),
        );

        expect(again.status).toBe('rotated');
        expect((await store.find(session.id))?.revokedAt).toBeNull();
      });

      it('revokes the session once the window has passed', async () => {
        const { store } = await seed();
        await store.rotate(rotateInput({ now: T0 + MINUTE }));

        const late = await store.rotate(
          rotateInput({
            newHash: 'hash-3',
            now: T0 + MINUTE + 10_001,
            reuseGraceMs: 10_000,
          }),
        );

        expect(late.status).toBe('reuse_detected');
      });

      it('lets two concurrent rotations both succeed inside the window', async () => {
        const { store } = await seed();

        const results = await Promise.all([
          store.rotate(
            rotateInput({ newHash: 'hash-a', reuseGraceMs: 10_000 }),
          ),
          store.rotate(
            rotateInput({ newHash: 'hash-b', reuseGraceMs: 10_000 }),
          ),
        ]);

        expect(results.map((r) => r.status)).toEqual(['rotated', 'rotated']);
      });
    });

    describe('revoke', () => {
      it('marks the session revoked and returns it', async () => {
        const { store, session } = await seed();

        const revoked = await store.revoke(session.id, T0 + MINUTE);

        expect(revoked?.revokedAt).toBe(T0 + MINUTE);
        expect((await store.find(session.id))?.revokedAt).toBe(T0 + MINUTE);
      });

      it('is idempotent and keeps the first revocation time', async () => {
        const { store, session } = await seed();
        await store.revoke(session.id, T0 + MINUTE);

        const again = await store.revoke(session.id, T0 + 2 * MINUTE);

        expect(again?.revokedAt).toBe(T0 + MINUTE);
      });

      it('returns null for an unknown session', async () => {
        const store = await createStore();

        expect(await store.revoke('missing', T0)).toBeNull();
      });
    });

    describe('subject queries', () => {
      async function seedMany() {
        const store = await createStore();
        const sessions = [
          makeSession({ id: 's-1', subject: 'alice' }),
          makeSession({ id: 's-2', subject: 'alice' }),
          makeSession({ id: 's-3', subject: 'alice', revokedAt: T0 }),
          makeSession({ id: 's-4', subject: 'alice', expiresAt: T0 + MINUTE }),
          makeSession({ id: 's-5', subject: 'bob' }),
        ];
        for (const session of sessions) {
          await store.create({
            session,
            refreshToken: makeToken(`hash-${session.id}`, session),
          });
        }
        return store;
      }

      const ids = (sessions: Session[]) => sessions.map((s) => s.id).sort();

      it('lists only active sessions of the subject', async () => {
        const store = await seedMany();

        const listed = await store.listForSubject('alice', T0 + 2 * MINUTE);

        expect(ids(listed)).toEqual(['s-1', 's-2']);
      });

      it('revokes every active session of the subject and no others', async () => {
        const store = await seedMany();
        const now = T0 + 2 * MINUTE;

        const revoked = await store.revokeAllForSubject('alice', now);

        expect(ids(revoked)).toEqual(['s-1', 's-2']);
        expect((await store.find('s-1'))?.revokedAt).toBe(now);
        expect((await store.find('s-3'))?.revokedAt).toBe(T0);
        expect((await store.find('s-5'))?.revokedAt).toBeNull();
        expect(await store.listForSubject('alice', now)).toEqual([]);
      });
    });

    describe('purgeExpired', () => {
      it('removes expired sessions and keeps active ones', async () => {
        const store = await createStore();
        if (!store.purgeExpired) return;
        const expired = makeSession({ id: 'old', expiresAt: T0 + MINUTE });
        const active = makeSession({ id: 'live' });
        await store.create({
          session: expired,
          refreshToken: makeToken('hash-old', expired),
        });
        await store.create({
          session: active,
          refreshToken: makeToken('hash-live', active),
        });

        const removed = await store.purgeExpired(T0 + 2 * MINUTE);

        expect(removed).toBe(1);
        expect(await store.find('old')).toBeNull();
        expect(await store.find('live')).not.toBeNull();
        expect(
          (
            await store.rotate(
              rotateInput({ presentedHash: 'hash-old', now: T0 + 2 * MINUTE }),
            )
          ).status,
        ).toBe('unknown_token');
        expect(
          await store.listForSubject('user-1', T0 + 2 * MINUTE),
        ).toHaveLength(1);
      });
    });
  });
}
