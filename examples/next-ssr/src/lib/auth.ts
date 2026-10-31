import { createToklynServer } from '@toklyn/next/server';
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
    // Parallel page and prefetch requests refresh with the same cookie.
    reuseGraceMs: 10_000,
  });
  const toklyn = createToklynServer(auth, {
    loginPath: '/login',
    isPublic: (pathname) => pathname === '/' || pathname === '/login',
  });
  return { auth, toklyn };
}

// The proxy and each route can get separate module copies, so share one instance.
const store = globalThis as typeof globalThis & {
  toklynSsrExample?: ReturnType<typeof create>;
};
export const { auth, toklyn } = (store.toklynSsrExample ??= create());

// Demo only: replace with your user lookup and a password hash check.
export function findUser(
  username: unknown,
  password: unknown,
): { id: string; role: string } | null {
  return username === 'demo' && password === 'demo'
    ? { id: 'user-1', role: 'admin' }
    : null;
}

/** Only local paths, so `?from=` cannot send users to another site. */
export function safeReturnPath(from: unknown): string {
  return typeof from === 'string' &&
    from.startsWith('/') &&
    !from.startsWith('//') &&
    !from.includes('\\')
    ? from
    : '/dashboard';
}
