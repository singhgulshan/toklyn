import { createToklynNext } from '@toklyn/next';
import { randomBytes } from 'node:crypto';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  createAuth,
} from 'toklyn';

interface AppClaims {
  role: string;
}

function create() {
  // A fresh key per start logs everyone out on restart; load a stored secret in production.
  const keyConfig = {
    keys: [{ algorithm: 'HS256' as const, secret: randomBytes(32) }],
  };
  const auth = createAuth<AppClaims>({
    signer: new JwtAccessTokenSigner(keyConfig),
    verifier: new JwtAccessTokenVerifier(keyConfig),
    sessions: new MemorySessionStore(),
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 60 * 60,
    sessionMaxAgeSeconds: 24 * 60 * 60,
  });
  return { auth, toklyn: createToklynNext(auth) };
}

// Routes can get separate module copies (and dev reloads re-run modules), so share one instance.
const store = globalThis as typeof globalThis & {
  toklynExample?: ReturnType<typeof create>;
};
export const { auth, toklyn } = (store.toklynExample ??= create());

// Demo only: replace with your user lookup and a password hash check.
export function findUser(
  username: unknown,
  password: unknown,
): { id: string; role: string } | null {
  return username === 'demo' && password === 'demo'
    ? { id: 'user-1', role: 'admin' }
    : null;
}
