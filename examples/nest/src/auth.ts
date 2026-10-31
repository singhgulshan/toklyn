import { randomBytes } from 'node:crypto';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  createAuth,
} from 'toklyn';
import type { Auth } from 'toklyn';

export interface AppClaims {
  role: string;
}

export const AUTH = Symbol('AUTH');

export function createAppAuth(): Auth<AppClaims> {
  // A fresh key per start logs everyone out on restart; load a stored secret in production.
  const keyConfig = {
    keys: [{ algorithm: 'HS256' as const, secret: randomBytes(32) }],
  };
  return createAuth<AppClaims>({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions: new MemorySessionStore(),
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 60 * 60,
    sessionMaxAgeSeconds: 24 * 60 * 60,
  });
}

// Demo only: replace with your user lookup and a password hash check.
export function findUser(
  username: unknown,
  password: unknown,
): { id: string; role: string } | null {
  return username === 'demo' && password === 'demo'
    ? { id: 'user-1', role: 'admin' }
    : null;
}
