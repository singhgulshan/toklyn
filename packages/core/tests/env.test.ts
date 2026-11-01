import { SignJWT, decodeProtectedHeader } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToklynHttp, httpOptionsFromEnv } from '#src/http/index.js';
import {
  JwtAccessTokenVerifier,
  MemorySessionStore,
  ToklynError,
  accessTokensFromEnv,
  createAuth,
} from '#src/index.js';
import type { AccessTokenClaims, ToklynEnv } from '#src/index.js';

const NOW = 1_700_000_000_000;
const IAT = NOW / 1000;
const SECRET = 'q7Vh3kZ1x9Lr2Yt0cWb8NfJmA4sPeD6uGiHoKjRlTzE=';
const OTHER = 'correct-horse-battery-staple-river-moon';

const claims: AccessTokenClaims = {
  sub: 'user-1',
  sid: 'session-1',
  jti: 'jti-1',
  iat: IAT,
  exp: IAT + 900,
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('accessTokensFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('signs and verifies with TOKLYN_SECRET', async () => {
    const { signer, verifier } = accessTokensFromEnv({
      env: { TOKLYN_SECRET: SECRET },
    });

    const token = await signer.sign(claims);

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'HS256' });
    expect(await verifier.verify(token, NOW)).toMatchObject(claims);
  });

  it('uses the secret as text, not decoded', async () => {
    const { signer } = accessTokensFromEnv({ env: { TOKLYN_SECRET: SECRET } });
    const token = await signer.sign(claims);
    const { kid } = decodeProtectedHeader(token);
    const explicit = new JwtAccessTokenVerifier({
      keys: [
        {
          kid,
          algorithm: 'HS256',
          secret: new TextEncoder().encode(SECRET),
        },
      ],
    });

    expect(await explicit.verify(token, NOW)).toMatchObject(claims);
  });

  it('derives a stable kid that does not contain the secret', async () => {
    const first = accessTokensFromEnv({ env: { TOKLYN_SECRET: SECRET } });
    const second = accessTokensFromEnv({ env: { TOKLYN_SECRET: SECRET } });
    const other = accessTokensFromEnv({ env: { TOKLYN_SECRET: OTHER } });

    const kidOf = async (tokens: typeof first) =>
      decodeProtectedHeader(await tokens.signer.sign(claims)).kid;
    const kid = await kidOf(first);

    expect(kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await kidOf(second)).toBe(kid);
    expect(await kidOf(other)).not.toBe(kid);
    expect(SECRET).not.toContain(kid);
  });

  it('accepts tokens signed with TOKLYN_SECRET_PREVIOUS but signs with the current one', async () => {
    const before = accessTokensFromEnv({ env: { TOKLYN_SECRET: OTHER } });
    const oldToken = await before.signer.sign(claims);
    const after = accessTokensFromEnv({
      env: { TOKLYN_SECRET: SECRET, TOKLYN_SECRET_PREVIOUS: OTHER },
    });
    const newToken = await after.signer.sign(claims);

    expect(await after.verifier.verify(oldToken, NOW)).toMatchObject(claims);
    expect(decodeProtectedHeader(newToken).kid).not.toBe(
      decodeProtectedHeader(oldToken).kid,
    );
    await expect(before.verifier.verify(newToken, NOW)).rejects.toMatchObject({
      code: 'invalid_access_token',
    });
  });

  it('rejects tokens after the previous secret is removed', async () => {
    const before = accessTokensFromEnv({ env: { TOKLYN_SECRET: OTHER } });
    const oldToken = await before.signer.sign(claims);
    const after = accessTokensFromEnv({ env: { TOKLYN_SECRET: SECRET } });

    await expect(after.verifier.verify(oldToken, NOW)).rejects.toMatchObject({
      code: 'invalid_access_token',
    });
  });

  it('applies TOKLYN_ISSUER and TOKLYN_AUDIENCE', async () => {
    const { signer, verifier } = accessTokensFromEnv({
      env: {
        TOKLYN_SECRET: SECRET,
        TOKLYN_ISSUER: 'https://auth.example.com',
        TOKLYN_AUDIENCE: ' api , admin ,',
      },
    });
    const token = await signer.sign(claims);

    expect(await verifier.verify(token, NOW)).toMatchObject({
      iss: 'https://auth.example.com',
      aud: ['api', 'admin'],
    });

    const foreign = await new SignJWT({ ...claims, aud: 'api' })
      .setProtectedHeader({
        alg: 'HS256',
        kid: decodeProtectedHeader(token).kid,
      })
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifier.verify(foreign, NOW)).rejects.toMatchObject({
      code: 'invalid_access_token',
    });
  });

  it('uses a single audience as a string', async () => {
    const { signer } = accessTokensFromEnv({
      env: { TOKLYN_SECRET: SECRET, TOKLYN_AUDIENCE: 'api' },
    });
    const token = await signer.sign(claims);
    const payload = JSON.parse(
      atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;

    expect(payload.aud).toBe('api');
  });

  it('treats empty values as unset', async () => {
    const { signer } = accessTokensFromEnv({
      env: { TOKLYN_SECRET: SECRET, TOKLYN_ISSUER: '', TOKLYN_AUDIENCE: '' },
    });
    const token = await signer.sign(claims);
    const payload = JSON.parse(
      atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;

    expect(payload).not.toHaveProperty('iss');
    expect(payload).not.toHaveProperty('aud');
  });

  it.each<[string, ToklynEnv]>([
    ['missing', {}],
    ['empty', { TOKLYN_SECRET: '' }],
    ['short', { TOKLYN_SECRET: 'mysecret' }],
    ['31 bytes', { TOKLYN_SECRET: 'a'.repeat(31) }],
    ['short previous', { TOKLYN_SECRET: SECRET, TOKLYN_SECRET_PREVIOUS: 'x' }],
    [
      'previous equal to current',
      { TOKLYN_SECRET: SECRET, TOKLYN_SECRET_PREVIOUS: SECRET },
    ],
  ])('rejects a %s secret at startup', (_, env) => {
    expect(codeOf(() => accessTokensFromEnv({ env }))).toBe('invalid_config');
  });

  it('counts bytes, not characters', () => {
    // 16 characters, 32 bytes in UTF-8.
    const env = { TOKLYN_SECRET: 'é'.repeat(16) };

    expect(codeOf(() => accessTokensFromEnv({ env }))).toBeUndefined();
  });

  it('never puts the secret in the error message', () => {
    const weak = 'my-weak-secret';
    const message = messageOf(() =>
      accessTokensFromEnv({ env: { TOKLYN_SECRET: weak } }),
    );

    expect(message).toContain('TOKLYN_SECRET');
    expect(message).toContain('openssl rand -base64 32');
    expect(message).not.toContain(weak);
  });

  it('reads process.env by default', async () => {
    vi.stubEnv('TOKLYN_SECRET', SECRET);
    const { signer, verifier } = accessTokensFromEnv();

    expect(await verifier.verify(await signer.sign(claims), NOW)).toMatchObject(
      claims,
    );
  });

  it('works with createAuth', async () => {
    const auth = createAuth({
      ...accessTokensFromEnv({ env: { TOKLYN_SECRET: SECRET } }),
      sessions: new MemorySessionStore(),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      sessionMaxAgeSeconds: 86_400,
    });
    const tokens = await auth.createSession({ subject: 'user-1' });

    expect(await auth.verifyAccessToken(tokens.accessToken)).toMatchObject({
      sub: 'user-1',
    });
  });
});

describe('httpOptionsFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads allowed origins and the cookie domain', () => {
    const options = httpOptionsFromEnv(
      {},
      {
        env: {
          TOKLYN_ALLOWED_ORIGINS:
            'https://app.example.com, https://admin.example.com',
          TOKLYN_COOKIE_DOMAIN: 'example.com',
        },
      },
    );

    expect(options).toEqual({
      allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
      cookie: { domain: 'example.com' },
    });
  });

  it('sets the domain on both cookies in cookie mode', () => {
    const options = httpOptionsFromEnv(
      { accessToken: 'cookie' },
      { env: { TOKLYN_COOKIE_DOMAIN: 'example.com' } },
    );

    expect(options).toEqual({
      accessToken: 'cookie',
      cookie: { domain: 'example.com' },
      accessCookie: { domain: 'example.com' },
    });
  });

  it('keeps explicit values', () => {
    const options = httpOptionsFromEnv(
      {
        allowedOrigins: ['https://mine.example.com'],
        cookie: { name: 'rt', domain: 'mine.example.com' },
      },
      {
        env: {
          TOKLYN_ALLOWED_ORIGINS: 'https://app.example.com',
          TOKLYN_COOKIE_DOMAIN: 'example.com',
        },
      },
    );

    expect(options).toEqual({
      allowedOrigins: ['https://mine.example.com'],
      cookie: { name: 'rt', domain: 'mine.example.com' },
    });
  });

  it('keeps other cookie options when adding the domain', () => {
    const options = httpOptionsFromEnv(
      { cookie: { name: 'rt', sameSite: 'Lax' } },
      { env: { TOKLYN_COOKIE_DOMAIN: 'example.com' } },
    );

    expect(options.cookie).toEqual({
      name: 'rt',
      sameSite: 'Lax',
      domain: 'example.com',
    });
  });

  it('returns the options unchanged when nothing is set', () => {
    const options = { accessToken: 'bearer' as const };

    expect(httpOptionsFromEnv(options, { env: {} })).toEqual(options);
  });

  it('leaves validation to createToklynHttp', () => {
    const auth = createAuth({
      ...accessTokensFromEnv({ env: { TOKLYN_SECRET: SECRET } }),
      sessions: new MemorySessionStore(),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      sessionMaxAgeSeconds: 86_400,
    });
    const badOrigin = httpOptionsFromEnv(
      {},
      { env: { TOKLYN_ALLOWED_ORIGINS: 'https://app.example.com/path' } },
    );
    const badDomain = httpOptionsFromEnv(
      {},
      { env: { TOKLYN_COOKIE_DOMAIN: 'evil.com; Path=/x' } },
    );

    expect(codeOf(() => createToklynHttp(auth, badOrigin))).toBe(
      'invalid_config',
    );
    expect(codeOf(() => createToklynHttp(auth, badDomain))).toBe(
      'invalid_config',
    );
  });

  it('switches the cookie prefix to __Secure- when a domain is set', () => {
    const auth = createAuth({
      ...accessTokensFromEnv({ env: { TOKLYN_SECRET: SECRET } }),
      sessions: new MemorySessionStore(),
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      sessionMaxAgeSeconds: 86_400,
    });
    const http = createToklynHttp(
      auth,
      httpOptionsFromEnv({}, { env: { TOKLYN_COOKIE_DOMAIN: 'example.com' } }),
    );

    expect(http.cookieName).toBe('__Secure-toklyn_refresh');
  });

  it('reads process.env by default', () => {
    vi.stubEnv('TOKLYN_COOKIE_DOMAIN', 'example.com');

    expect(httpOptionsFromEnv().cookie).toEqual({ domain: 'example.com' });
  });
});
