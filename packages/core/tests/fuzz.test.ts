import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createCookie,
  extractBearerToken,
  isTrustedOrigin,
  readCookie,
} from '#src/http/index.js';
import { ToklynError } from '#src/index.js';
import { createTestAuth } from '#src/test-utils/index.js';

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return 'accepted';
}

/** Replaces one character before the last, whose spare base64url bits may not change the bytes. */
const mutation = (length: number) =>
  fc.record({
    index: fc.nat({ max: length - 2 }),
    char: fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.',
    ),
  });

function mutate(token: string, index: number, char: string): string | null {
  if (token[index] === char) return null;
  return token.slice(0, index) + char + token.slice(index + 1);
}

describe('property-based security checks', () => {
  describe('access tokens', () => {
    it('rejects arbitrary strings', async () => {
      const { auth } = createTestAuth();
      await fc.assert(
        fc.asyncProperty(fc.string({ maxLength: 512 }), async (token) => {
          expect(await codeOf(auth.verifyAccessToken(token))).toBe(
            'invalid_access_token',
          );
        }),
      );
    });

    it('rejects any single-character change to a valid token', async () => {
      const { auth } = createTestAuth();
      const { accessToken } = await auth.createSession({ subject: 'user-1' });
      await fc.assert(
        fc.asyncProperty(
          mutation(accessToken.length),
          async ({ index, char }) => {
            const forged = mutate(accessToken, index, char);
            if (forged === null) return;
            expect(await codeOf(auth.verifyAccessToken(forged))).toBe(
              'invalid_access_token',
            );
          },
        ),
      );
    });
  });

  describe('refresh tokens', () => {
    it('rejects arbitrary and session-prefixed guesses without touching the session', async () => {
      const { auth } = createTestAuth();
      const pair = await auth.createSession({ subject: 'user-1' });
      const guess = fc.oneof(
        fc.string({ maxLength: 256 }),
        fc.string({ maxLength: 64 }).map((rest) => `${pair.sessionId}.${rest}`),
      );
      await fc.assert(
        fc.asyncProperty(guess, async (refreshToken) => {
          fc.pre(refreshToken !== pair.refreshToken);
          expect(await codeOf(auth.refresh({ refreshToken }))).toBe(
            'invalid_refresh_token',
          );
        }),
      );
      await expect(
        auth.refresh({ refreshToken: pair.refreshToken }),
      ).resolves.toMatchObject({ sessionId: pair.sessionId });
    });

    it('rejects any single-character change to a valid token', async () => {
      const { auth } = createTestAuth();
      const pair = await auth.createSession({ subject: 'user-1' });
      await fc.assert(
        fc.asyncProperty(
          mutation(pair.refreshToken.length),
          async ({ index, char }) => {
            const forged = mutate(pair.refreshToken, index, char);
            if (forged === null) return;
            expect(await codeOf(auth.refresh({ refreshToken: forged }))).toBe(
              'invalid_refresh_token',
            );
          },
        ),
      );
      await expect(
        auth.refresh({ refreshToken: pair.refreshToken }),
      ).resolves.toMatchObject({ sessionId: pair.sessionId });
    });
  });

  describe('http primitives', () => {
    it('extractBearerToken never throws and returns only a token68 value', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 512 }), (header) => {
          const token = extractBearerToken(header);
          if (token !== null) {
            expect(token).toMatch(/^[A-Za-z0-9\-._~+/]+=*$/);
            expect(header.endsWith(token)).toBe(true);
          }
        }),
      );
    });

    it('readCookie never throws and never returns a value with a separator', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 512 }), (header) => {
          const value = readCookie(header, 'session');
          if (value !== null) expect(value).not.toContain(';');
        }),
      );
    });

    it('cookies round-trip, and unsafe values cannot inject attributes', () => {
      const cookie = createCookie({ name: 'session', sameSite: 'Lax' });
      fc.assert(
        fc.property(
          fc.string({ maxLength: 128 }),
          fc.string({ maxLength: 64 }),
          (token, other) => {
            let header: string;
            try {
              header = cookie.serialize(token, 60_000, 0);
            } catch (error) {
              expect(error).toBeInstanceOf(ToklynError);
              return;
            }
            expect(header).toBe(
              `${cookie.name}=${token}; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax`,
            );
            const sent = `other=${encodeURIComponent(other)}; ${cookie.name}=${token}`;
            expect(readCookie(sent, cookie.name)).toBe(token);
          },
        ),
      );
    });

    it('isTrustedOrigin rejects every origin not on the allow-list', () => {
      const allowed = new Set(['https://app.example.com']);
      fc.assert(
        fc.property(
          fc.option(fc.oneof(fc.webUrl(), fc.string()), { nil: undefined }),
          fc.option(fc.string(), { nil: undefined }),
          (origin, secFetchSite) => {
            fc.pre(origin === undefined || !allowed.has(origin));
            fc.pre(secFetchSite !== 'same-origin');
            expect(isTrustedOrigin({ origin, secFetchSite }, allowed)).toBe(
              false,
            );
          },
        ),
      );
    });
  });
});
