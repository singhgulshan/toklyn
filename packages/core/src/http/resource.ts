import { systemClock } from '#src/clock.js';
import type { AccessTokenVerifier, Clock } from '#src/contracts.js';
import type { JsonWebKeySet } from '#src/crypto/jwks.js';
import { ToklynError } from '#src/errors.js';
import type {
  AccessTokenClaims,
  ClaimsShape,
  CustomClaims,
} from '#src/types.js';
import { extractBearerToken } from './bearer.js';
import { toToklynHttpError } from './errors.js';
import type {
  ToklynAuthenticator,
  ToklynHttpRequest,
  ToklynHttpResponse,
} from './http-auth.js';

export interface ToklynResourceOptions {
  /** The time tokens are checked against. Defaults to the system clock. */
  clock?: Clock;
}

/** Verify-only authentication for services that accept tokens but never issue them. */
export type ToklynResource<TClaims extends ClaimsShape = CustomClaims> =
  ToklynAuthenticator<TClaims>;

/**
 * Bearer-only authentication from a verifier, e.g. a `RemoteJwksAccessTokenVerifier`.
 * Checks are offline: a revoked token stays valid until it expires.
 */
export function createToklynResource<
  TClaims extends ClaimsShape = CustomClaims,
>(
  verifier: AccessTokenVerifier,
  options: ToklynResourceOptions = {},
): ToklynResource<TClaims> {
  if (typeof verifier?.verify !== 'function') {
    throw new ToklynError('invalid_config', 'verifier must have verify()');
  }
  const clock = options.clock ?? systemClock;

  async function verify(
    token: string,
  ): Promise<AccessTokenClaims<TClaims> | 401 | 503> {
    try {
      return (await verifier.verify(
        token,
        clock.now(),
      )) as AccessTokenClaims<TClaims>;
    } catch (error) {
      const mapped = toToklynHttpError(error);
      if (!mapped) throw error;
      return mapped.status;
    }
  }

  return {
    async authenticate(request) {
      const token = readToken(request);
      if (token === null) return { ok: false, response: failure(401) };
      const result = await verify(token);
      if (typeof result === 'number') {
        return { ok: false, response: failure(result) };
      }
      return { ok: true, claims: result };
    },

    async authenticateOptional(request, optionalOptions = {}) {
      const invalidToken = optionalOptions.invalidToken ?? 'reject';
      if (invalidToken !== 'reject' && invalidToken !== 'ignore') {
        throw new ToklynError(
          'invalid_config',
          'invalidToken must be "reject" or "ignore"',
        );
      }
      const token = readToken(request);
      if (token === null) return { ok: true, claims: null };
      const result = await verify(token);
      if (result === 401 && invalidToken === 'ignore') {
        return { ok: true, claims: null };
      }
      if (typeof result === 'number') {
        return { ok: false, response: failure(result) };
      }
      return { ok: true, claims: result };
    },
  };
}

/** Response for a `/.well-known/jwks.json` route. Build the set once with `createJwks`. */
export function jwksResponse(jwks: JsonWebKeySet): ToklynHttpResponse {
  return {
    status: 200,
    headers: [['Cache-Control', 'public, max-age=300']],
    body: jwks,
  };
}

function readToken(request: ToklynHttpRequest): string | null {
  return extractBearerToken(request.header('authorization'));
}

function failure(status: 401 | 503): ToklynHttpResponse {
  return status === 401
    ? {
        status,
        headers: [
          ['WWW-Authenticate', 'Bearer'],
          ['Cache-Control', 'no-store'],
        ],
        body: { error: 'unauthorized' },
      }
    : {
        status,
        headers: [['Cache-Control', 'no-store']],
        body: { error: 'service_unavailable' },
      };
}
