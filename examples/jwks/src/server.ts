import { createToklynExpress, jwksHandler } from '@toklyn/express';
import { createToklynFastifyResource, getAuth } from '@toklyn/fastify';
import express from 'express';
import Fastify from 'fastify';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  RemoteJwksAccessTokenVerifier,
  createAuth,
  createJwks,
} from 'toklyn';
import type { AsymmetricKeyConfig } from 'toklyn';

interface AppClaims {
  role: string;
}

const AUTH_PORT = Number(process.env.AUTH_PORT ?? 4000);
const API_PORT = Number(process.env.API_PORT ?? 4001);
const ISSUER = `http://localhost:${AUTH_PORT}`;
const AUDIENCE = `http://localhost:${API_PORT}`;

// --- Auth service (Express): signs tokens with a private key, publishes the public key. ---

// Demo only: a new key pair per start. Load your keys from a secret manager, e.g. with
// jose's importPKCS8 / importSPKI(pem, 'ES256', { extractable: true }).
const pair = (await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;
const signingKey: AsymmetricKeyConfig = {
  kid: `key-${new Date().toISOString().slice(0, 10)}`,
  algorithm: 'ES256',
  privateKey: pair.privateKey,
  publicKey: pair.publicKey,
};
const keyConfig = { keys: [signingKey], issuer: ISSUER, audience: AUDIENCE };

const auth = createAuth<AppClaims>({
  signer: new JwtAccessTokenSigner(keyConfig),
  verifier: new JwtAccessTokenVerifier(keyConfig),
  sessions: new MemorySessionStore(),
  accessTokenTtlSeconds: 5 * 60,
  refreshTokenTtlSeconds: 60 * 60,
  sessionMaxAgeSeconds: 24 * 60 * 60,
});
const toklyn = createToklynExpress(auth);

const authApp = express();
// Only the public half of the key is published; HS keys never are.
authApp.get(
  '/.well-known/jwks.json',
  jwksHandler(await createJwks(keyConfig.keys)),
);
authApp.post('/login', async (_req, res) => {
  // Demo only: your credential check goes here.
  const tokens = await auth.createSession({
    subject: 'user-1',
    claims: { role: 'admin' },
  });
  toklyn.sendSession(res, tokens);
});
authApp.post('/refresh', toklyn.refreshHandler);
authApp.post('/logout', toklyn.logoutHandler);
authApp.listen(AUTH_PORT);

// --- API service (Fastify): no secrets and no session store, only the JWKS URL. ---

const verifier = new RemoteJwksAccessTokenVerifier({
  url: `${ISSUER}/.well-known/jwks.json`,
  algorithms: ['ES256'],
  issuer: ISSUER,
  audience: AUDIENCE,
});
const resource = createToklynFastifyResource(verifier);

const api = Fastify();
api.get('/orders', { preHandler: resource.requireAuth }, async (request) => {
  const { sub, role } = getAuth<AppClaims>(request);
  return { owner: sub, role, orders: [] };
});
await api.listen({ port: API_PORT });

console.log(`Auth service: ${ISSUER} (JWKS at ${ISSUER}/.well-known/jwks.json)
API service:  ${AUDIENCE}

Try it:
  TOKEN=$(curl -s -X POST ${ISSUER}/login | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
  curl -H "authorization: Bearer $TOKEN" ${AUDIENCE}/orders`);
