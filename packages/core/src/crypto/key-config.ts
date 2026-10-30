export type SymmetricAlgorithm = 'HS256' | 'HS384' | 'HS512';
export type AsymmetricAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA';

/** The algorithm always comes from config, never from the token header. */
export interface SymmetricKeyConfig {
  kid?: string;
  algorithm: SymmetricAlgorithm;
  /** At least 32 bytes. */
  secret: Uint8Array;
}

export interface AsymmetricKeyConfig {
  kid?: string;
  algorithm: AsymmetricAlgorithm;
  /** Omit on verify-only services. */
  privateKey?: CryptoKey;
  publicKey: CryptoKey;
}

export type SigningKeyConfig = SymmetricKeyConfig | AsymmetricKeyConfig;

export interface AccessTokenConfig {
  /** All keys accepted for verification. Several may be active during key rotation. */
  keys: SigningKeyConfig[];
  /** `kid` of the key used for signing. Defaults to the only key when there is one. */
  signingKid?: string;
  issuer?: string;
  audience?: string | string[];
  clockToleranceSeconds?: number;
}
