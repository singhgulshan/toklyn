import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createToklynResource, jwksResponse } from '#src/http/index.js';
import type { ToklynHttpRequest } from '#src/http/index.js';
import {
  JwtAccessTokenSigner,
  RemoteJwksAccessTokenVerifier,
  ToklynError,
  createJwks,
} from '#src/index.js';
import type {
  AccessTokenClaims,
  AccessTokenVerifier,
  AsymmetricAlgorithm,
  AsymmetricKeyConfig,
  JsonWebKeySet,
  RemoteJwksConfig,
} from '#src/index.js';

const NOW = 1_700_000_000_000;
const IAT = NOW / 1000;
const URL_ = 'https://auth.example.com/.well-known/jwks.json';

function claims(overrides: Record<string, unknown> = {}): AccessTokenClaims {
  return {
    sub: 'user-1',
    sid: 'session-1',
    jti: 'jti-1',
    iat: IAT,
    exp: IAT + 900,
    ...overrides,
  };
}

async function keyPair(
  algorithm: AsymmetricAlgorithm,
  kid?: string,
): Promise<AsymmetricKeyConfig> {
  const { privateKey, publicKey } = await generateKeyPair(algorithm);
  return { kid, algorithm, privateKey, publicKey };
}

function sign(key: AsymmetricKeyConfig, payload = claims()) {
  return new JwtAccessTokenSigner({ keys: [key] }).sign(payload);
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

function syncErrorCode(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

/** Serves whatever `body` currently is and counts requests. */
function fakeEndpoint(body: unknown) {
  const endpoint = {
    body,
    status: 200,
    calls: 0,
    fetch: (async () => {
      endpoint.calls += 1;
      return new Response(
        typeof endpoint.body === 'string'
          ? endpoint.body
          : JSON.stringify(endpoint.body),
        { status: endpoint.status },
      );
    }) as typeof fetch,
  };
  return endpoint;
}

function remote(
  fetchImpl: typeof fetch,
  overrides: Partial<RemoteJwksConfig> = {},
) {
  return new RemoteJwksAccessTokenVerifier({
    url: URL_,
    algorithms: ['ES256', 'RS256', 'EdDSA'],
    fetch: fetchImpl,
    ...overrides,
  });
}

describe('createJwks', () => {
  let es256: AsymmetricKeyConfig;
  let rs256: AsymmetricKeyConfig;
  let ed25519: AsymmetricKeyConfig;

  beforeAll(async () => {
    [es256, rs256, ed25519] = await Promise.all([
      keyPair('ES256', 'es'),
      keyPair('RS256', 'rs'),
      keyPair('EdDSA', 'ed'),
    ]);
  });

  it('publishes only public parameters with kid, alg and use', async () => {
    const jwks = await createJwks([es256, rs256, ed25519]);
    expect(jwks.keys.map((key) => Object.keys(key).sort())).toEqual([
      ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y'],
      ['alg', 'e', 'kid', 'kty', 'n', 'use'],
      ['alg', 'crv', 'kid', 'kty', 'use', 'x'],
    ]);
    expect(jwks.keys[0]).toMatchObject({
      kty: 'EC',
      crv: 'P-256',
      kid: 'es',
      alg: 'ES256',
      use: 'sig',
    });
    expect(jwks.keys[2]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(JSON.stringify(jwks)).not.toMatch(/"(d|p|q|dp|dq|qi)"/);
  });

  it('publishes verify-only keys', async () => {
    const { privateKey: _, ...verifyOnly } = rs256;
    const jwks = await createJwks([es256, verifyOnly]);
    expect(jwks.keys.map((key) => key.kid)).toEqual(['es', 'rs']);
  });

  it('never publishes HS keys', async () => {
    const hs = {
      kid: 'hs',
      algorithm: 'HS256' as const,
      secret: new Uint8Array(32).fill(1),
    };
    const jwks = await createJwks([hs, es256]);
    expect(jwks.keys.map((key) => key.kid)).toEqual(['es']);
    expect(await errorCode(createJwks([hs]))).toBe('invalid_config');
    expect(await errorCode(createJwks([]))).toBe('invalid_config');
  });

  it('requires a unique kid on every published key', async () => {
    const { kid: _, ...noKid } = es256;
    expect(await errorCode(createJwks([noKid]))).toBe('invalid_config');
    expect(await errorCode(createJwks([{ ...es256, kid: '' }]))).toBe(
      'invalid_config',
    );
    expect(await errorCode(createJwks([es256, { ...rs256, kid: 'es' }]))).toBe(
      'invalid_config',
    );
  });

  it('rejects a private key in place of the public key', async () => {
    const swapped = { ...es256, publicKey: es256.privateKey as CryptoKey };
    expect(await errorCode(createJwks([swapped]))).toBe('invalid_config');
  });

  it('explains non-extractable public keys', async () => {
    const spki = await crypto.subtle.exportKey('spki', es256.publicKey);
    const publicKey = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const error = await createJwks([{ ...es256, publicKey }]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ToklynError);
    expect((error as ToklynError).message).toMatch(/extractable/);
  });
});

describe('RemoteJwksAccessTokenVerifier', () => {
  let es256: AsymmetricKeyConfig;
  let rs256: AsymmetricKeyConfig;
  let jwks: JsonWebKeySet;

  beforeAll(async () => {
    [es256, rs256] = await Promise.all([
      keyPair('ES256', 'es'),
      keyPair('RS256', 'rs'),
    ]);
    jwks = await createJwks([es256]);
  });

  it('verifies tokens signed with a published key', async () => {
    const endpoint = fakeEndpoint(jwks);
    const verifier = remote(endpoint.fetch);
    await expect(verifier.verify(await sign(es256), NOW)).resolves.toEqual(
      claims(),
    );
  });

  it('fetches once and reuses the keys', async () => {
    const endpoint = fakeEndpoint(jwks);
    const verifier = remote(endpoint.fetch);
    const token = await sign(es256);
    await Promise.all([
      verifier.verify(token, NOW),
      verifier.verify(token, NOW),
    ]);
    await verifier.verify(token, NOW);
    expect(endpoint.calls).toBe(1);
  });

  it('refetches for an unknown kid after the cooldown', async () => {
    const endpoint = fakeEndpoint(jwks);
    const verifier = remote(endpoint.fetch, { cooldownMs: 0 });
    await verifier.verify(await sign(es256), NOW);

    endpoint.body = await createJwks([es256, rs256]);
    await expect(verifier.verify(await sign(rs256), NOW)).resolves.toEqual(
      claims(),
    );
    expect(endpoint.calls).toBe(2);
  });

  it('does not refetch for an unknown kid during the cooldown', async () => {
    const endpoint = fakeEndpoint(jwks);
    const verifier = remote(endpoint.fetch);
    await verifier.verify(await sign(es256), NOW);

    endpoint.body = await createJwks([es256, rs256]);
    expect(await errorCode(verifier.verify(await sign(rs256), NOW))).toBe(
      'invalid_access_token',
    );
    expect(endpoint.calls).toBe(1);
  });

  it('only accepts the configured algorithms', async () => {
    const endpoint = fakeEndpoint(jwks);
    const verifier = remote(endpoint.fetch, { algorithms: ['RS256'] });
    expect(await errorCode(verifier.verify(await sign(es256), NOW))).toBe(
      'invalid_access_token',
    );
  });

  it('rejects HS tokens even when the kid matches', async () => {
    const endpoint = fakeEndpoint(jwks);
    const hsToken = await new JwtAccessTokenSigner({
      keys: [
        {
          kid: 'es',
          algorithm: 'HS256',
          secret: new TextEncoder().encode(JSON.stringify(jwks.keys[0])),
        },
      ],
    }).sign(claims());
    expect(await errorCode(remote(endpoint.fetch).verify(hsToken, NOW))).toBe(
      'invalid_access_token',
    );
  });

  it('checks expiry, issuer and audience', async () => {
    const endpoint = fakeEndpoint(jwks);
    const token = await sign(es256);
    expect(
      await errorCode(remote(endpoint.fetch).verify(token, NOW + 901_000)),
    ).toBe('access_token_expired');
    expect(
      await errorCode(
        remote(endpoint.fetch, { issuer: 'https://auth' }).verify(token, NOW),
      ),
    ).toBe('invalid_access_token');
    expect(
      await errorCode(
        remote(endpoint.fetch, { audience: 'api' }).verify(token, NOW),
      ),
    ).toBe('invalid_access_token');
  });

  it('rejects malformed and oversized tokens without fetching', async () => {
    const endpoint = fakeEndpoint(jwks);
    const verifier = remote(endpoint.fetch);
    expect(await errorCode(verifier.verify('x'.repeat(20_000), NOW))).toBe(
      'invalid_access_token',
    );
    expect(await errorCode(verifier.verify('not-a-jwt', NOW))).toBe(
      'invalid_access_token',
    );
    expect(endpoint.calls).toBe(0);
  });

  it.each([
    ['a non-200 answer', { status: 500 }],
    ['invalid JSON', { body: '{' }],
    ['a malformed key set', { body: { keys: 'none' } }],
  ])('gives storage_error for %s', async (_, change) => {
    const endpoint = Object.assign(fakeEndpoint(jwks), change);
    expect(
      await errorCode(remote(endpoint.fetch).verify(await sign(es256), NOW)),
    ).toBe('storage_error');
  });

  it('gives storage_error when the network fails', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(
      await errorCode(remote(failing).verify(await sign(es256), NOW)),
    ).toBe('storage_error');
  });

  it('gives storage_error on timeout', async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      })) as typeof fetch;
    const verifier = remote(hanging, { timeoutMs: 10 });
    expect(await errorCode(verifier.verify(await sign(es256), NOW))).toBe(
      'storage_error',
    );
  });

  it('recovers once the endpoint is back', async () => {
    const endpoint = Object.assign(fakeEndpoint(jwks), { status: 503 });
    const verifier = remote(endpoint.fetch);
    const token = await sign(es256);
    expect(await errorCode(verifier.verify(token, NOW))).toBe('storage_error');
    endpoint.status = 200;
    await expect(verifier.verify(token, NOW)).resolves.toEqual(claims());
  });

  it('validates its config', () => {
    const ok = fakeEndpoint(jwks).fetch;
    const create = (overrides: Partial<RemoteJwksConfig>) => () =>
      remote(ok, overrides);
    expect(syncErrorCode(create({}))).toBeUndefined();
    expect(
      syncErrorCode(create({ url: 'http://localhost:3000/jwks.json' })),
    ).toBeUndefined();
    expect(
      syncErrorCode(create({ url: new URL('http://127.0.0.1/jwks.json') })),
    ).toBeUndefined();
    for (const overrides of [
      { url: 'http://auth.example.com/jwks.json' },
      { url: 'ftp://auth.example.com/jwks.json' },
      { url: '/jwks.json' },
      { algorithms: [] },
      { algorithms: ['HS256'] as unknown as AsymmetricAlgorithm[] },
      { algorithms: ['none'] as unknown as AsymmetricAlgorithm[] },
      { timeoutMs: -1 },
      { cooldownMs: 1.5 },
      { cacheMaxAgeMs: Number.NaN },
      { fetch: 'nope' as unknown as typeof fetch },
    ]) {
      expect(syncErrorCode(create(overrides))).toBe('invalid_config');
    }
  });
});

describe('createToklynResource', () => {
  const validClaims = claims();

  function verifierThat(
    behaviour: (token: string, now: number) => Promise<AccessTokenClaims>,
  ): AccessTokenVerifier & { nows: number[] } {
    const nows: number[] = [];
    return {
      nows,
      verify(token, now) {
        nows.push(now);
        return behaviour(token, now);
      },
    };
  }

  const accepting = verifierThat(async (token) => {
    if (token === 'good') return validClaims;
    if (token === 'down') throw new ToklynError('storage_error', 'down');
    if (token === 'bug') throw new Error('bug');
    throw new ToklynError('invalid_access_token', 'bad');
  });

  function request(authorization?: string): ToklynHttpRequest {
    return {
      method: 'POST',
      header: (name) => (name === 'authorization' ? authorization : 'ignored'),
    };
  }

  it('authenticates Bearer tokens', async () => {
    const resource = createToklynResource(accepting);
    await expect(
      resource.authenticate(request('Bearer good')),
    ).resolves.toEqual({ ok: true, claims: validClaims });
  });

  it('answers 401 with WWW-Authenticate and 503 without', async () => {
    const resource = createToklynResource(accepting);
    for (const header of [undefined, 'Bearer bad', 'Basic good']) {
      const result = await resource.authenticate(request(header));
      expect(result).toEqual({
        ok: false,
        response: {
          status: 401,
          headers: [
            ['WWW-Authenticate', 'Bearer'],
            ['Cache-Control', 'no-store'],
          ],
          body: { error: 'unauthorized' },
        },
      });
    }
    const down = await resource.authenticate(request('Bearer down'));
    expect(down).toEqual({
      ok: false,
      response: {
        status: 503,
        headers: [['Cache-Control', 'no-store']],
        body: { error: 'service_unavailable' },
      },
    });
  });

  it('propagates unexpected errors', async () => {
    const resource = createToklynResource(accepting);
    await expect(resource.authenticate(request('Bearer bug'))).rejects.toThrow(
      'bug',
    );
  });

  it('lets guests through with authenticateOptional', async () => {
    const resource = createToklynResource(accepting);
    expect(await resource.authenticateOptional(request())).toEqual({
      ok: true,
      claims: null,
    });
    expect(
      (await resource.authenticateOptional(request('Bearer bad'))).ok,
    ).toBe(false);
    expect(
      await resource.authenticateOptional(request('Bearer bad'), {
        invalidToken: 'ignore',
      }),
    ).toEqual({ ok: true, claims: null });
    expect(
      (
        await resource.authenticateOptional(request('Bearer down'), {
          invalidToken: 'ignore',
        })
      ).ok,
    ).toBe(false);
    expect(
      await errorCode(
        resource.authenticateOptional(request(), {
          invalidToken: 'maybe' as 'ignore',
        }),
      ),
    ).toBe('invalid_config');
  });

  it('checks tokens against the given clock', async () => {
    const verifier = verifierThat(async () => validClaims);
    const resource = createToklynResource(verifier, {
      clock: { now: () => 42 },
    });
    await resource.authenticate(request('Bearer good'));
    expect(verifier.nows).toEqual([42]);
  });

  it('requires a verifier', () => {
    expect(
      syncErrorCode(() =>
        createToklynResource({} as unknown as AccessTokenVerifier),
      ),
    ).toBe('invalid_config');
  });
});

describe('jwksResponse', () => {
  it('serves the set with a public cache header', async () => {
    const jwks = await createJwks([await keyPair('ES256', 'es')]);
    expect(jwksResponse(jwks)).toEqual({
      status: 200,
      headers: [['Cache-Control', 'public, max-age=300']],
      body: jwks,
    });
  });
});
