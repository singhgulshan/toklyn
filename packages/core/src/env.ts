import type { AccessTokenSigner, AccessTokenVerifier } from '#src/contracts.js';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
} from '#src/crypto/jwt-access-tokens.js';
import type { AccessTokenConfig } from '#src/crypto/key-config.js';
import { ToklynError } from '#src/errors.js';
import type { AccessTokenClaims } from '#src/types.js';

export type ToklynEnv = Readonly<Record<string, string | undefined>>;

export interface FromEnvOptions {
  /** Defaults to `process.env`. Pass the env object on runtimes without one, e.g. Cloudflare Workers. */
  env?: ToklynEnv;
}

export interface EnvAccessTokens {
  signer: AccessTokenSigner;
  verifier: AccessTokenVerifier;
}

const MIN_SECRET_BYTES = 32;
const GENERATE_HINT = 'Generate one with: openssl rand -base64 32';

/**
 * HS256 signer and verifier from `TOKLYN_SECRET` (any text, at least 32 bytes, used as is),
 * plus optional `TOKLYN_SECRET_PREVIOUS` (verify only, for rotation), `TOKLYN_ISSUER` and
 * `TOKLYN_AUDIENCE` (comma-separated).
 */
export function accessTokensFromEnv(
  options: FromEnvOptions = {},
): EnvAccessTokens {
  const env = resolveEnv(options.env);
  const current = readSecret(env, 'TOKLYN_SECRET', true);
  const previous = readSecret(env, 'TOKLYN_SECRET_PREVIOUS', false);
  if (previous !== undefined && sameBytes(current, previous)) {
    throw invalidConfig(
      'TOKLYN_SECRET_PREVIOUS must differ from TOKLYN_SECRET',
    );
  }
  const issuer = readOptional(env, 'TOKLYN_ISSUER');
  const audience = readList(env, 'TOKLYN_AUDIENCE');

  let built: Promise<EnvAccessTokens> | undefined;
  const ready = () => (built ??= build());

  async function build(): Promise<EnvAccessTokens> {
    const kid = await keyId(current);
    const config: AccessTokenConfig = {
      keys: [{ kid, algorithm: 'HS256', secret: current }],
      signingKid: kid,
      ...(issuer !== undefined && { issuer }),
      ...(audience.length > 0 && {
        audience: audience.length === 1 ? audience[0] : audience,
      }),
    };
    if (previous !== undefined) {
      config.keys.push({
        kid: await keyId(previous),
        algorithm: 'HS256',
        secret: previous,
      });
    }
    return {
      signer: new JwtAccessTokenSigner(config),
      verifier: new JwtAccessTokenVerifier(config),
    };
  }

  return {
    signer: {
      sign: async (claims: AccessTokenClaims) =>
        (await ready()).signer.sign(claims),
    },
    verifier: {
      verify: async (token: string, now: number) =>
        (await ready()).verifier.verify(token, now),
    },
  };
}

/** Reads `globalThis.process.env` unless an env object is given. */
export function resolveEnv(env: ToklynEnv | undefined): ToklynEnv {
  if (env !== undefined) return env;
  const processEnv = (globalThis as { process?: { env?: ToklynEnv } }).process
    ?.env;
  if (processEnv === undefined) {
    throw invalidConfig('No process.env on this runtime; pass { env }');
  }
  return processEnv;
}

/** Unset and empty values are both treated as not configured. */
export function readOptional(env: ToklynEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function readList(env: ToklynEnv, name: string): string[] {
  return (readOptional(env, name) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function readSecret(env: ToklynEnv, name: string, required: true): Uint8Array;
function readSecret(
  env: ToklynEnv,
  name: string,
  required: false,
): Uint8Array | undefined;
function readSecret(
  env: ToklynEnv,
  name: string,
  required: boolean,
): Uint8Array | undefined {
  const value = readOptional(env, name);
  if (value === undefined) {
    if (required) throw invalidConfig(`${name} is not set. ${GENERATE_HINT}`);
    return undefined;
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < MIN_SECRET_BYTES) {
    throw invalidConfig(
      `${name} must be at least ${MIN_SECRET_BYTES} bytes. ${GENERATE_HINT}`,
    );
  }
  return bytes;
}

/** Derived from the secret so rotation needs no naming; it does not reveal the secret. */
async function keyId(secret: Uint8Array): Promise<string> {
  const label = new TextEncoder().encode('toklyn-kid:');
  const input = new Uint8Array(label.length + secret.length);
  input.set(label);
  input.set(secret, label.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return btoa(String.fromCharCode(...digest.subarray(0, 12)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}
