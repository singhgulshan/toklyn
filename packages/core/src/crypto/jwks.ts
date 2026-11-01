import { exportJWK } from 'jose';
import { ToklynError } from '#src/errors.js';
import type { AsymmetricAlgorithm, SigningKeyConfig } from './key-config.js';

export interface PublicJwk {
  kty: string;
  kid: string;
  alg: AsymmetricAlgorithm;
  use: 'sig';
  /** Public key parameters, e.g. `n` and `e` for RSA. */
  [parameter: string]: string;
}

export interface JsonWebKeySet {
  keys: PublicJwk[];
}

// An allow-list, so private parameters can never end up in the published set.
const PUBLIC_PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  RSA: ['n', 'e'],
  EC: ['crv', 'x', 'y'],
  OKP: ['crv', 'x'],
};

/**
 * The public keys to serve at `/.well-known/jwks.json`. Symmetric (HS) keys are skipped,
 * since their secret would be published. Every published key needs a `kid`, and public
 * keys must be extractable (e.g. `importSPKI(pem, alg, { extractable: true })`).
 */
export async function createJwks(
  keys: readonly SigningKeyConfig[],
): Promise<JsonWebKeySet> {
  const published: PublicJwk[] = [];
  const kids = new Set<string>();

  for (const key of keys) {
    if ('secret' in key) continue;
    const { kid } = key;
    if (typeof kid !== 'string' || kid === '') {
      throw invalidConfig('Every published key needs a kid');
    }
    if (kids.has(kid)) throw invalidConfig(`Duplicate key id "${kid}"`);
    kids.add(kid);
    if (key.publicKey?.type !== 'public') {
      throw invalidConfig(`publicKey of "${kid}" is not a public key`);
    }

    let jwk: Record<string, unknown>;
    try {
      jwk = { ...(await exportJWK(key.publicKey)) };
    } catch (cause) {
      throw new ToklynError(
        'invalid_config',
        `Could not export "${kid}"; import public keys as extractable`,
        { cause },
      );
    }
    const kty = jwk.kty;
    const parameters =
      typeof kty === 'string' ? PUBLIC_PARAMETERS[kty] : undefined;
    if (typeof kty !== 'string' || !parameters) {
      throw invalidConfig(`Unsupported key type for "${kid}"`);
    }

    const entry: PublicJwk = { kty, kid, alg: key.algorithm, use: 'sig' };
    for (const name of parameters) {
      const value = jwk[name];
      if (typeof value !== 'string') {
        throw invalidConfig(`Could not export "${kid}"`);
      }
      entry[name] = value;
    }
    published.push(entry);
  }

  if (published.length === 0) {
    throw invalidConfig(
      'createJwks needs at least one asymmetric key; HS keys are never published',
    );
  }
  return { keys: published };
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}
