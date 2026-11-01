import { describe, expect, it } from 'vitest';
import { MemorySessionStore, ToklynError } from '#src/index.js';
import { createTestAuth, createTestClock } from '#src/test-utils/index.js';

describe('createTestClock', () => {
  it('only moves when told to', () => {
    const clock = createTestClock(1000);

    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});

describe('createTestAuth', () => {
  it('creates, verifies and refreshes a session', async () => {
    const { auth } = createTestAuth<{ role: string }>();
    const tokens = await auth.createSession({
      subject: 'user-1',
      claims: { role: 'admin' },
    });

    expect(await auth.verifyAccessToken(tokens.accessToken)).toMatchObject({
      sub: 'user-1',
      role: 'admin',
    });
    const next = await auth.refresh({ refreshToken: tokens.refreshToken });
    expect(next.sessionId).toBe(tokens.sessionId);
  });

  it('expires access tokens when the clock moves', async () => {
    const { auth, clock } = createTestAuth({ accessTokenTtlSeconds: 60 });
    const { accessToken } = await auth.createSession({ subject: 'user-1' });

    clock.advance(61_000);

    await expect(auth.verifyAccessToken(accessToken)).rejects.toMatchObject({
      code: 'access_token_expired',
    });
  });

  it('detects refresh token reuse', async () => {
    const { auth, sessions } = createTestAuth();
    const tokens = await auth.createSession({ subject: 'user-1' });
    await auth.refresh({ refreshToken: tokens.refreshToken });

    await expect(
      auth.refresh({ refreshToken: tokens.refreshToken }),
    ).rejects.toBeInstanceOf(ToklynError);
    expect((await sessions.find(tokens.sessionId))?.revokedAt).not.toBeNull();
  });

  it('supports access token revocation', async () => {
    const { auth } = createTestAuth({ verification: 'online' });
    const { accessToken } = await auth.createSession({ subject: 'user-1' });

    await auth.revokeAccessToken(accessToken);

    await expect(auth.verifyAccessToken(accessToken)).rejects.toMatchObject({
      code: 'access_token_revoked',
    });
  });

  it('uses a different key per call', async () => {
    const first = createTestAuth();
    const second = createTestAuth();
    const { accessToken } = await first.auth.createSession({
      subject: 'user-1',
    });

    await expect(
      second.auth.verifyAccessToken(accessToken),
    ).rejects.toMatchObject({ code: 'invalid_access_token' });
  });

  it('accepts overrides and a start time', async () => {
    const sessions = new MemorySessionStore();
    const { auth, clock } = createTestAuth({ sessions, startAt: 5_000_000 });
    const { sessionId } = await auth.createSession({ subject: 'user-1' });

    expect(clock.now()).toBe(5_000_000);
    expect((await sessions.find(sessionId))?.createdAt).toBe(5_000_000);
  });
});
