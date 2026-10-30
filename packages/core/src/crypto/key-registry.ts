import { ToklynError } from '#src/errors.js';
import type {
  AccessTokenConfig,
  SigningKeyConfig,
  SymmetricAlgorithm,
  SymmetricKeyConfig,
} from './key-config.js';

export type KeyMaterial = CryptoKey;

/** RFC 7518: an HMAC key must be at least as long as the hash output. */
const MIN_SECRET_BYTES: Record<SymmetricAlgorithm, number> = {
  HS256: 32,
  HS384: 48,
  HS512: 64,
};

function isSymmetric(key: SigningKeyConfig): key is SymmetricKeyConfig {
  return 'secret' in key;
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}

/** Validates the key set once and answers which key signs and which verifies. */
export class KeyRegistry {
  private readonly keys: SigningKeyConfig[];
  private readonly byKid = new Map<string, SigningKeyConfig>();
  private readonly hmacKeys = new Map<SymmetricKeyConfig, Promise<CryptoKey>>();

  constructor(private readonly config: AccessTokenConfig) {
    if (config.keys.length === 0) {
      throw invalidConfig('At least one key is required');
    }

    // Secrets are copied so later changes to the caller's buffer cannot alter a live key.
    this.keys = config.keys.map((key) =>
      isSymmetric(key) ? { ...key, secret: key.secret.slice() } : key,
    );

    for (const key of this.keys) {
      if (this.keys.length > 1 && key.kid === undefined) {
        throw invalidConfig(
          'Every key needs a kid when several are configured',
        );
      }
      if (key.kid !== undefined) {
        if (this.byKid.has(key.kid)) {
          throw invalidConfig(`Duplicate key id "${key.kid}"`);
        }
        this.byKid.set(key.kid, key);
      }
      if (
        isSymmetric(key) &&
        key.secret.length < MIN_SECRET_BYTES[key.algorithm]
      ) {
        throw invalidConfig(
          `${key.algorithm} secrets must be at least ${MIN_SECRET_BYTES[key.algorithm]} bytes`,
        );
      }
    }

    if (config.signingKid !== undefined && !this.byKid.has(config.signingKid)) {
      throw invalidConfig(
        `signingKid "${config.signingKid}" is not a configured key`,
      );
    }
  }

  signingKey(): SigningKeyConfig {
    const { signingKid } = this.config;
    const key =
      signingKid !== undefined ? this.byKid.get(signingKid) : this.keys[0];
    if (!key || (signingKid === undefined && this.keys.length > 1)) {
      throw invalidConfig(
        'signingKid is required when several keys are configured',
      );
    }
    if (!isSymmetric(key) && !key.privateKey) {
      throw invalidConfig('The signing key has no private key');
    }
    return key;
  }

  /** `kid` comes from the token header and only selects among our own keys. */
  verificationKey(kid: string | undefined): SigningKeyConfig | undefined {
    if (kid !== undefined) return this.byKid.get(kid);
    return this.keys.length === 1 ? this.keys[0] : undefined;
  }

  signingMaterial(key: SigningKeyConfig): Promise<KeyMaterial> {
    return isSymmetric(key)
      ? this.hmacKey(key)
      : Promise.resolve(key.privateKey as CryptoKey);
  }

  verificationMaterial(key: SigningKeyConfig): Promise<KeyMaterial> {
    return isSymmetric(key)
      ? this.hmacKey(key)
      : Promise.resolve(key.publicKey);
  }

  /** Imported once and reused; importing per call is the dominant cost of HMAC verification. */
  private hmacKey(key: SymmetricKeyConfig): Promise<CryptoKey> {
    let imported = this.hmacKeys.get(key);
    if (!imported) {
      imported = crypto.subtle.importKey(
        'raw',
        key.secret as Uint8Array<ArrayBuffer>,
        { name: 'HMAC', hash: `SHA-${key.algorithm.slice(2)}` },
        false,
        ['sign', 'verify'],
      );
      this.hmacKeys.set(key, imported);
    }
    return imported;
  }
}
