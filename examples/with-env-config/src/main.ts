import { randomBytes } from 'node:crypto';
import {
  MemorySessionStore,
  ToklynError,
  accessTokensFromEnv,
  createAuth,
} from 'toklyn';
import type { ToklynEnv } from 'toklyn';
import { createToklynHttp, httpOptionsFromEnv } from 'toklyn/http';

// `pnpm start` loads your `.env` into process.env; `pnpm check` fills it with samples.
if (process.argv.includes('--check')) Object.assign(process.env, sampleEnv());
const { env } = process;

// 1. Access tokens from TOKLYN_SECRET, TOKLYN_SECRET_PREVIOUS, TOKLYN_ISSUER, TOKLYN_AUDIENCE,
//    read from process.env. A missing or short secret throws here, at startup.
let tokens: ReturnType<typeof accessTokensFromEnv>;
try {
  tokens = accessTokensFromEnv();
} catch (error) {
  if (error instanceof ToklynError && error.code === 'invalid_config') {
    console.error(`Config error: ${error.message}`);
    console.error('Copy .env.example to .env and fill in TOKLYN_SECRET.');
    process.exit(1);
  }
  throw error;
}

const auth = createAuth({
  ...tokens,
  sessions: new MemorySessionStore(),
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
  sessionMaxAgeSeconds: 30 * 24 * 60 * 60,
});

// 2. HTTP options from TOKLYN_ALLOWED_ORIGINS and TOKLYN_COOKIE_DOMAIN. Values set in code win.
const httpOptions = httpOptionsFromEnv({ accessToken: 'bearer' });
const http = createToklynHttp(auth, httpOptions);

console.log('Configuration (secrets are never printed)');
show('issuer (iss)', env.TOKLYN_ISSUER);
show('audience (aud)', env.TOKLYN_AUDIENCE);
show('previous secret', env.TOKLYN_SECRET_PREVIOUS ? 'set' : undefined);
show('allowed origins', httpOptions.allowedOrigins?.join(', '));
show('cookie domain', httpOptions.cookie?.domain);
// `__Host-` without a domain; a domain makes it `__Secure-`.
show('refresh cookie', http.cookieName);

// 3. Tokens carry the configured issuer and audience, and are checked against them.
const session = await auth.createSession({ subject: 'user-1' });
const claims = (await auth.verifyAccessToken(session.accessToken)) as Record<
  string,
  unknown
>;
console.log('\nSigned in and verified');
show('iss', String(claims.iss ?? ''));
show('aud', JSON.stringify(claims.aud ?? null));

// 4. Rotating the secret: move the old value to TOKLYN_SECRET_PREVIOUS and set a new one.
//    Tokens signed with the old secret still verify until they expire; new ones use the new.
//    The `env` option stands in for three deploys here; it is also how runtimes without
//    process.env (e.g. Cloudflare Workers) pass their bindings.
const oldSecret = randomBytes(32).toString('base64');
const newSecret = randomBytes(32).toString('base64');
const before = accessTokensFromEnv({ env: { TOKLYN_SECRET: oldSecret } });
const oldToken = await before.signer.sign({
  sub: 'user-1',
  sid: 'session-1',
  jti: 'token-1',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 60,
});
const during = accessTokensFromEnv({
  env: { TOKLYN_SECRET: newSecret, TOKLYN_SECRET_PREVIOUS: oldSecret },
});
const after = accessTokensFromEnv({ env: { TOKLYN_SECRET: newSecret } });
const verifies = (verifier: typeof during.verifier) =>
  verifier.verify(oldToken, Date.now()).then(
    () => true,
    () => false,
  );
console.log('\nSecret rotation');
const duringOk = await verifies(during.verifier);
const afterOk = await verifies(after.verifier);
show('old token, new + previous', duringOk ? 'accepted' : 'rejected');
show('old token, new only', afterOk ? 'accepted' : 'rejected');
if (!duringOk || afterOk) throw new Error('Secret rotation check failed');

function show(label: string, value: string | undefined): void {
  console.log(`  ${label.padEnd(26)} ${value ?? '(not set)'}`);
}

/** Sample values for `pnpm check`; your real values belong in `.env` or your secret manager. */
function sampleEnv(): ToklynEnv {
  return {
    TOKLYN_SECRET: randomBytes(32).toString('base64'),
    TOKLYN_SECRET_PREVIOUS: randomBytes(32).toString('base64'),
    TOKLYN_ISSUER: 'https://auth.example.com',
    TOKLYN_AUDIENCE: 'https://api.example.com,https://admin.example.com',
    TOKLYN_ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
    TOKLYN_COOKIE_DOMAIN: 'example.com',
  };
}
