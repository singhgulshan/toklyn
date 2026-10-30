import { SignJWT, decodeProtectedHeader, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  ToklynError,
} from '#src/index.js';
import type {
  AccessTokenClaims,
  AccessTokenConfig,
  SymmetricAlgorithm,
  SymmetricKeyConfig,
} from '#src/index.js';

const NOW = 1_700_000_000_000;
const IAT = NOW / 1000;
const TTL = 900;

function claims(overrides: Record<string, unknown> = {}): AccessTokenClaims {
  return {
    sub: 'user-1',
    sid: 'session-1',
    jti: 'jti-1',
    iat: IAT,
    exp: IAT + TTL,
    role: 'admin',
    ...overrides,
  };
}

function hsKey(
  kid?: string,
  bytes = 32,
  algorithm: SymmetricAlgorithm = 'HS256',
): SymmetricKeyConfig {
  return {
    kid,
    algorithm,
    secret: crypto.getRandomValues(new Uint8Array(bytes)),
  };
}

async function signWith(config: AccessTokenConfig, payload = claims()) {
  return new JwtAccessTokenSigner(config).sign(payload);
}

function verify(config: AccessTokenConfig, token: string, now = NOW) {
  return new JwtAccessTokenVerifier(config).verify(token, now);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

async function rejectionCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof ToklynError ? error.code : 'not_toklyn_error';
  }
  return undefined;
}

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

describe('access tokens', () => {
  let es256: AccessTokenConfig;
  let ed25519: AccessTokenConfig;
  let rs256: AccessTokenConfig;
  let es256Verifier: AccessTokenConfig;

  beforeAll(async () => {
    const [es, ed, rs] = await Promise.all([
      generateKeyPair('ES256'),
      generateKeyPair('EdDSA'),
      generateKeyPair('RS256'),
    ]);
    es256 = {
      keys: [
        {
          kid: 'es-1',
          algorithm: 'ES256',
          privateKey: es.privateKey,
          publicKey: es.publicKey,
        },
      ],
    };
    es256Verifier = {
      keys: [{ kid: 'es-1', algorithm: 'ES256', publicKey: es.publicKey }],
    };
    ed25519 = {
      keys: [
        {
          algorithm: 'EdDSA',
          privateKey: ed.privateKey,
          publicKey: ed.publicKey,
        },
      ],
    };
    rs256 = {
      keys: [
        {
          kid: 'rsa-1',
          algorithm: 'RS256',
          privateKey: rs.privateKey,
          publicKey: rs.publicKey,
        },
      ],
    };
  });

  describe('round trip', () => {
    it('works with a symmetric key', async () => {
      const config = { keys: [hsKey()] };

      const token = await signWith(config);

      expect(await verify(config, token)).toEqual(claims());
    });

    it.each(['es256', 'ed25519', 'rs256'] as const)(
      'works with an asymmetric %s key',
      async (name) => {
        const config = { es256, ed25519, rs256 }[name];

        const token = await signWith(config);

        expect(await verify(config, token)).toEqual(claims());
      },
    );

    it('writes alg, typ and kid into the header', async () => {
      const token = await signWith(es256);

      expect(decodeProtectedHeader(token)).toEqual({
        alg: 'ES256',
        typ: 'JWT',
        kid: 'es-1',
      });
    });

    it('verifies with a public key only', async () => {
      const token = await signWith(es256);

      expect(await verify(es256Verifier, token)).toEqual(claims());
    });
  });

  describe('issuer and audience', () => {
    const key = hsKey();
    const configured = { keys: [key], issuer: 'toklyn', audience: 'api' };

    it('stamps them on signed tokens and returns them', async () => {
      const token = await signWith(configured);

      const verified = await verify(configured, token);

      expect(verified.iss).toBe('toklyn');
      expect(verified.aud).toBe('api');
    });

    it('rejects a different issuer', async () => {
      const token = await signWith(configured);

      expect(
        await rejectionCode(verify({ ...configured, issuer: 'other' }, token)),
      ).toBe('invalid_access_token');
    });

    it('rejects a different audience', async () => {
      const token = await signWith(configured);

      expect(
        await rejectionCode(verify({ ...configured, audience: 'web' }, token)),
      ).toBe('invalid_access_token');
    });

    it('rejects a token without an issuer when one is required', async () => {
      const token = await signWith({ keys: [key] });

      expect(await rejectionCode(verify(configured, token))).toBe(
        'invalid_access_token',
      );
    });
  });

  describe('expiry', () => {
    const config = { keys: [hsKey()] };

    it('rejects an expired token with access_token_expired', async () => {
      const token = await signWith(config);

      expect(
        await rejectionCode(verify(config, token, NOW + (TTL + 1) * 1000)),
      ).toBe('access_token_expired');
    });

    it('rejects a token at the exact expiry instant', async () => {
      const token = await signWith(config);

      expect(await rejectionCode(verify(config, token, NOW + TTL * 1000))).toBe(
        'access_token_expired',
      );
    });

    it('uses the supplied time, not the system clock', async () => {
      const token = await signWith(config);

      expect(await verify(config, token, NOW + 1000)).toEqual(claims());
    });

    it('accepts a slightly expired token within the clock tolerance', async () => {
      const tolerant = { ...config, clockToleranceSeconds: 5 };
      const token = await signWith(tolerant);

      expect(await verify(tolerant, token, NOW + (TTL + 3) * 1000)).toEqual(
        claims(),
      );
    });
  });

  describe('invalid tokens', () => {
    const config = { keys: [hsKey()] };

    it("is not affected by later changes to the caller's secret buffer", async () => {
      const key = hsKey();
      const signer = new JwtAccessTokenSigner({ keys: [key] });
      const verifier = new JwtAccessTokenVerifier({ keys: [key] });

      key.secret.fill(0);

      expect(await verifier.verify(await signer.sign(claims()), NOW)).toEqual(
        claims(),
      );
    });

    it('rejects garbage', async () => {
      expect(await rejectionCode(verify(config, 'not-a-token'))).toBe(
        'invalid_access_token',
      );
    });

    it('rejects an oversized token before parsing it', async () => {
      expect(
        await rejectionCode(verify(config, `${'a'.repeat(20_000)}.b.c`)),
      ).toBe('invalid_access_token');
    });

    it('rejects a non-string token', async () => {
      expect(await rejectionCode(verify(config, undefined as never))).toBe(
        'invalid_access_token',
      );
    });

    it('rejects a tampered payload', async () => {
      const token = await signWith(config);
      const [header, , signature] = token.split('.');
      const forged = base64Url(claims({ sub: 'admin' }));

      expect(
        await rejectionCode(verify(config, `${header}.${forged}.${signature}`)),
      ).toBe('invalid_access_token');
    });

    it('rejects a token signed with a different key', async () => {
      const token = await signWith({ keys: [hsKey()] });

      expect(await rejectionCode(verify(config, token))).toBe(
        'invalid_access_token',
      );
    });

    it.each(['sid', 'jti', 'sub'])(
      'rejects a token missing the %s claim',
      async (missing) => {
        const secret = new Uint8Array(32).fill(1);
        const { [missing]: _removed, ...payload } = claims();
        const token = await new SignJWT(payload)
          .setProtectedHeader({ alg: 'HS256' })
          .sign(secret);

        expect(
          await rejectionCode(
            verify({ keys: [{ algorithm: 'HS256', secret }] }, token),
          ),
        ).toBe('invalid_access_token');
      },
    );
  });

  describe('algorithm confusion', () => {
    it('rejects an HS256 token that names an RS256 key', async () => {
      const forged = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'HS256', kid: 'rsa-1' })
        .sign(new Uint8Array(32).fill(7));

      expect(await rejectionCode(verify(rs256, forged))).toBe(
        'invalid_access_token',
      );
    });

    it('rejects an unsigned alg=none token', async () => {
      const unsigned = `${base64Url({ alg: 'none', kid: 'es-1' })}.${base64Url(claims())}.`;

      expect(await rejectionCode(verify(es256, unsigned))).toBe(
        'invalid_access_token',
      );
    });

    it('rejects a token whose algorithm differs from the key algorithm', async () => {
      const es384 = await generateKeyPair('ES384');
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'ES384', kid: 'es-1' })
        .sign(es384.privateKey);

      expect(await rejectionCode(verify(es256, token))).toBe(
        'invalid_access_token',
      );
    });
  });

  describe('key rotation', () => {
    const oldKey = hsKey('old');
    const newKey = hsKey('new');

    it('verifies tokens from every active key', async () => {
      const both = { keys: [oldKey, newKey] };
      const oldToken = await signWith({ keys: [oldKey] });
      const newToken = await signWith({ ...both, signingKid: 'new' });

      expect(await verify(both, oldToken)).toEqual(claims());
      expect(await verify(both, newToken)).toEqual(claims());
      expect(decodeProtectedHeader(newToken).kid).toBe('new');
    });

    it('rejects tokens from a key that has been retired', async () => {
      const oldToken = await signWith({ keys: [oldKey] });

      expect(await rejectionCode(verify({ keys: [newKey] }, oldToken))).toBe(
        'invalid_access_token',
      );
    });

    it('rejects a token whose kid is unknown', async () => {
      const token = await signWith({ keys: [hsKey('other')] });

      expect(
        await rejectionCode(verify({ keys: [oldKey, newKey] }, token)),
      ).toBe('invalid_access_token');
    });
  });

  describe('configuration', () => {
    it('rejects an empty key list', () => {
      expect(codeOf(() => new JwtAccessTokenVerifier({ keys: [] }))).toBe(
        'invalid_config',
      );
    });

    it('rejects duplicate kids', () => {
      const config = { keys: [hsKey('a'), hsKey('a')] };

      expect(codeOf(() => new JwtAccessTokenVerifier(config))).toBe(
        'invalid_config',
      );
    });

    it('requires a kid on every key when there are several', () => {
      const config = { keys: [hsKey('a'), hsKey()] };

      expect(codeOf(() => new JwtAccessTokenVerifier(config))).toBe(
        'invalid_config',
      );
    });

    it('requires signingKid to name a configured key', () => {
      const config = { keys: [hsKey('a')], signingKid: 'missing' };

      expect(codeOf(() => new JwtAccessTokenSigner(config))).toBe(
        'invalid_config',
      );
    });

    it('requires signingKid when several keys are configured', () => {
      const config = { keys: [hsKey('a'), hsKey('b')] };

      expect(codeOf(() => new JwtAccessTokenSigner(config))).toBe(
        'invalid_config',
      );
    });

    it('does not need signingKid to verify', () => {
      const config = { keys: [hsKey('a'), hsKey('b')] };

      expect(codeOf(() => new JwtAccessTokenVerifier(config))).toBeUndefined();
    });

    it('rejects a signer built from a public key only', () => {
      expect(codeOf(() => new JwtAccessTokenSigner(es256Verifier))).toBe(
        'invalid_config',
      );
    });

    it.each([
      ['HS256', 31],
      ['HS384', 47],
      ['HS512', 63],
    ] as const)('rejects a too-short %s secret', (algorithm, bytes) => {
      const config = { keys: [hsKey(undefined, bytes, algorithm)] };

      expect(codeOf(() => new JwtAccessTokenVerifier(config))).toBe(
        'invalid_config',
      );
    });
  });
});
