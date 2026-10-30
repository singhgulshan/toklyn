import { describe, expect, it } from 'vitest';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  ToklynError,
  createAuth,
} from '#src/index.js';
import type { AccessTokenConfig } from '#src/index.js';

const keys: AccessTokenConfig = {
  keys: [{ algorithm: 'HS256', secret: new Uint8Array(32).fill(7) }],
};

function setup(config: AccessTokenConfig = keys) {
  const sessions = new MemorySessionStore();
  const auth = createAuth({
    signer: new JwtAccessTokenSigner(config),
    verifier: new JwtAccessTokenVerifier(config),
    sessions,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86_400,
    sessionMaxAgeSeconds: 86_400,
  });
  return { auth, sessions };
}

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

function forge(header: Record<string, unknown>) {
  const payload = { sub: 'u', sid: 's', jti: 'j', iat: 1, exp: 4_000_000_000 };
  return `${base64Url(header)}.${base64Url(payload)}.c2ln`;
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

describe('security', () => {
  describe('token header handling', () => {
    it.each([
      ['__proto__'],
      ['constructor'],
      ['toString'],
      [1],
      [{ a: 1 }],
      [['x']],
      [null],
    ])('rejects a forged kid of %j', async (kid) => {
      const { auth } = setup();

      expect(
        await codeOf(
          auth.verifyAccessToken(forge({ alg: 'HS256', typ: 'JWT', kid })),
        ),
      ).toBe('invalid_access_token');
    });

    it('rejects a token that embeds its own key', async () => {
      const { auth } = setup();
      const header = {
        alg: 'HS256',
        jwk: { kty: 'oct', k: base64Url('attacker-secret') },
      };

      expect(await codeOf(auth.verifyAccessToken(forge(header)))).toBe(
        'invalid_access_token',
      );
    });
  });

  describe('refresh tokens', () => {
    it('does not let garbage tokens revoke or disturb a live session', async () => {
      const { auth } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });

      for (const garbage of [
        '',
        ' ',
        pair.sessionId,
        pair.accessToken,
        'a'.repeat(43),
      ]) {
        expect(await codeOf(auth.refresh({ refreshToken: garbage }))).toBe(
          'invalid_refresh_token',
        );
      }

      expect(await auth.listSessions('user-1')).toHaveLength(1);
      expect(
        (await auth.refresh({ refreshToken: pair.refreshToken })).sessionId,
      ).toBe(pair.sessionId);
    });

    it('does not accept an access token as a refresh token', async () => {
      const { auth } = setup();
      const pair = await auth.createSession({ subject: 'user-1' });

      expect(
        await codeOf(auth.refresh({ refreshToken: pair.accessToken })),
      ).toBe('invalid_refresh_token');
    });
  });

  describe('claims', () => {
    it('does not let a __proto__ claim reach the prototype', async () => {
      const { auth } = setup();
      const claims = JSON.parse('{"__proto__":{"admin":true}}');

      const pair = await auth.createSession({ subject: 'user-1', claims });
      const verified = await auth.verifyAccessToken(pair.accessToken);

      expect(Object.getPrototypeOf(verified)).toBe(Object.prototype);
      expect((verified as Record<string, unknown>).admin).toBeUndefined();
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
    });
  });

  describe('errors', () => {
    it('does not expose the underlying cause when serialized', async () => {
      class DownStore extends MemorySessionStore {
        override async create(): Promise<void> {
          throw new Error('postgres://user:password@db/internal');
        }
      }
      const auth = createAuth({
        signer: new JwtAccessTokenSigner(keys),
        verifier: new JwtAccessTokenVerifier(keys),
        sessions: new DownStore(),
        accessTokenTtlSeconds: 900,
        refreshTokenTtlSeconds: 86_400,
        sessionMaxAgeSeconds: 86_400,
      });

      const error = (await auth
        .createSession({ subject: 'user-1' })
        .catch((e: unknown) => e)) as ToklynError;

      expect(error.code).toBe('storage_error');
      expect(error.message).not.toContain('password');
      expect(JSON.stringify(error)).not.toContain('password');
    });
  });
});
