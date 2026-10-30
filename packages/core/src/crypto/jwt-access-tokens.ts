import {
  SignJWT,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import type { AccessTokenSigner, AccessTokenVerifier } from '#src/contracts.js';
import { ToklynError } from '#src/errors.js';
import type { AccessTokenClaims } from '#src/types.js';
import type { AccessTokenConfig, SigningKeyConfig } from './key-config.js';
import { KeyRegistry } from './key-registry.js';

const REQUIRED_CLAIMS = ['exp', 'iat', 'sub', 'sid', 'jti'];
/** Far above any real token; bounds the work an attacker can force per request. */
const MAX_TOKEN_LENGTH = 16_384;

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

    try {
      const { payload } = await jwtVerify(token, material, {
        // Only the selected key's algorithm is accepted, never the header's.
        algorithms: [key.algorithm],
        issuer: this.config.issuer,
        audience: this.config.audience,
        clockTolerance: this.config.clockToleranceSeconds ?? 0,
        currentDate: new Date(now),
        requiredClaims: REQUIRED_CLAIMS,
      });
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
