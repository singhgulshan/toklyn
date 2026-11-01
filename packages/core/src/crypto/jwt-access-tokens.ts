import {
  SignJWT,
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { AccessTokenSigner, AccessTokenVerifier } from '#src/contracts.js';
import { ToklynError } from '#src/errors.js';
import type { AccessTokenClaims } from '#src/types.js';
import type {
  AccessTokenConfig,
  AsymmetricAlgorithm,
  SigningKeyConfig,
} from './key-config.js';
import { KeyRegistry } from './key-registry.js';

const REQUIRED_CLAIMS = ['exp', 'iat', 'sub', 'sid', 'jti'];
/** Far above any real token; bounds the work an attacker can force per request. */
const MAX_TOKEN_LENGTH = 16_384;
const ASYMMETRIC_ALGORITHMS: ReadonlySet<string> = new Set<AsymmetricAlgorithm>(
  [
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
    'ES256',
    'ES384',
    'ES512',
    'EdDSA',
  ],
);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

interface VerifyOptions {
  algorithms: readonly string[];
  issuer?: string;
  audience?: string | string[];
  clockToleranceSeconds?: number;
}

export class JwtAccessTokenSigner implements AccessTokenSigner {
  private readonly registry: KeyRegistry;
  private readonly key: SigningKeyConfig;

  constructor(private readonly config: AccessTokenConfig) {
    this.registry = new KeyRegistry(config);
    this.key = this.registry.signingKey();
  }

  async sign(claims: AccessTokenClaims): Promise<string> {
    const { key } = this;
    const { issuer, audience } = this.config;
    const payload = {
      ...claims,
      ...(issuer !== undefined && { iss: issuer }),
      ...(audience !== undefined && { aud: audience }),
    };

    try {
      return await new SignJWT(payload)
        .setProtectedHeader({
          alg: key.algorithm,
          typ: 'JWT',
          ...(key.kid !== undefined && { kid: key.kid }),
        })
        .sign(await this.registry.signingMaterial(key));
    } catch (cause) {
      throw new ToklynError(
        'invalid_config',
        'Could not sign the access token',
        {
          cause,
        },
      );
    }
  }
}

export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  private readonly keys: KeyRegistry;

  constructor(private readonly config: AccessTokenConfig) {
    this.keys = new KeyRegistry(config);
  }

  async verify(token: string, now: number): Promise<AccessTokenClaims> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
      throw invalidToken('Access token is malformed');
    }
    const key = this.keys.verificationKey(readKid(token));
    if (!key) throw invalidToken('Unknown signing key');
    const material = await this.keys.verificationMaterial(key);
    // Only the selected key's algorithm is accepted, never the header's.
    return verifyJwt(token, material, now, {
      ...this.config,
      algorithms: [key.algorithm],
    });
  }
}

export interface RemoteJwksConfig {
  /** The JWKS URL. Must be `https`, except on localhost. */
  url: string | URL;
  /** Accepted algorithms. Required, because the token header never chooses. */
  algorithms: readonly AsymmetricAlgorithm[];
  issuer?: string;
  audience?: string | string[];
  clockToleranceSeconds?: number;
  /** Fetch timeout. Default 5000. */
  timeoutMs?: number;
  /** Minimum time between refetches caused by an unknown `kid`. Default 30000. */
  cooldownMs?: number;
  /** Keys are refetched when older than this. Default 600000 (10 minutes). */
  cacheMaxAgeMs?: number;
  /** Replaces the global `fetch`, e.g. to go through a proxy. */
  fetch?: typeof fetch;
}

/**
 * Verifies access tokens against a published JWKS. Keys are cached, and an unknown `kid`
 * triggers a refetch (at most once per cooldown). A JWKS that cannot be fetched gives
 * `storage_error`.
 */
export class RemoteJwksAccessTokenVerifier implements AccessTokenVerifier {
  private readonly resolveKey: JWTVerifyGetKey;
  private readonly options: VerifyOptions;

  constructor(config: RemoteJwksConfig) {
    const url = parseJwksUrl(config.url);
    const { algorithms } = config;
    if (
      !Array.isArray(algorithms) ||
      algorithms.length === 0 ||
      !algorithms.every((algorithm) => ASYMMETRIC_ALGORITHMS.has(algorithm))
    ) {
      throw invalidConfig(
        'algorithms must list asymmetric algorithms, e.g. ["ES256"]',
      );
    }
    if (config.fetch !== undefined && typeof config.fetch !== 'function') {
      throw invalidConfig('fetch must be a function');
    }
    const remote = createRemoteJWKSet(url, {
      timeoutDuration: duration(config.timeoutMs, 'timeoutMs'),
      cooldownDuration: duration(config.cooldownMs, 'cooldownMs'),
      cacheMaxAge: duration(config.cacheMaxAgeMs, 'cacheMaxAgeMs'),
      ...(config.fetch && { [customFetch]: config.fetch }),
    });
    this.resolveKey = async (header, token) => {
      try {
        return await remote(header, token);
      } catch (cause) {
        throw keyError(cause);
      }
    };
    this.options = {
      algorithms: [...algorithms],
      issuer: config.issuer,
      audience: config.audience,
      clockToleranceSeconds: config.clockToleranceSeconds,
    };
  }

  async verify(token: string, now: number): Promise<AccessTokenClaims> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
      throw invalidToken('Access token is malformed');
    }
    return verifyJwt(token, this.resolveKey, now, this.options);
  }
}

async function verifyJwt(
  token: string,
  key: CryptoKey | JWTVerifyGetKey,
  now: number,
  options: VerifyOptions,
): Promise<AccessTokenClaims> {
  try {
    const verifyOptions = {
      algorithms: [...options.algorithms],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: options.clockToleranceSeconds ?? 0,
      currentDate: new Date(now),
      requiredClaims: REQUIRED_CLAIMS,
    };
    const { payload } =
      typeof key === 'function'
        ? await jwtVerify(token, key, verifyOptions)
        : await jwtVerify(token, key, verifyOptions);
    assertStandardClaims(payload);
    return payload as AccessTokenClaims;
  } catch (cause) {
    if (cause instanceof ToklynError) throw cause;
    if (cause instanceof joseErrors.JWTExpired) {
      throw new ToklynError('access_token_expired', 'Access token expired', {
        cause,
      });
    }
    throw invalidToken('Access token is invalid', cause);
  }
}

function parseJwksUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ToklynError('invalid_config', 'url must be an absolute URL', {
      cause,
    });
  }
  const local = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw invalidConfig('url must use https (http only on localhost)');
  }
  return url;
}

function duration(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
    throw invalidConfig(`${name} must be a non-negative integer`);
  }
  return value;
}

/** A key the token cannot match is the token's fault; anything else is the JWKS endpoint's. */
function keyError(cause: unknown): ToklynError {
  if (
    cause instanceof joseErrors.JWKSNoMatchingKey ||
    cause instanceof joseErrors.JWKSMultipleMatchingKeys ||
    cause instanceof joseErrors.JOSENotSupported
  ) {
    return invalidToken('Unknown signing key', cause);
  }
  return new ToklynError('storage_error', 'Could not load the JWKS', {
    cause,
  });
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}

function readKid(token: string): string | undefined {
  try {
    return decodeProtectedHeader(token).kid;
  } catch (cause) {
    throw invalidToken('Access token is malformed', cause);
  }
}

function assertStandardClaims(payload: Record<string, unknown>): void {
  for (const name of ['sub', 'sid', 'jti']) {
    if (typeof payload[name] !== 'string') {
      throw invalidToken(`Claim "${name}" must be a string`);
    }
  }
}

function invalidToken(message: string, cause?: unknown): ToklynError {
  return new ToklynError('invalid_access_token', message, { cause });
}
