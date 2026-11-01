import { randomBytes, randomUUID } from 'node:crypto';
import { ToklynError, accessTokensFromEnv, createAuth } from 'toklyn';
import type { StoreExample } from './example.js';
import { examples } from './examples.js';

const RACE_SIZE = 10;

// Usage: pnpm demo postgres/prisma   |   pnpm demo:all (skips examples whose database is not set)
const [arg] = process.argv.slice(2);

if (arg === '--all') {
  let failed = 0;
  for (const [name, entry] of Object.entries(examples)) {
    const missing = entry.needs.filter((variable) => !process.env[variable]);
    if (missing.length > 0) {
      console.log(`- ${name}: skipped, set ${missing.join(', ')}`);
      continue;
    }
    try {
      await run(name);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${name}:`, error);
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
} else if (arg && arg in examples) {
  await run(arg);
} else {
  console.error(`Usage: pnpm demo <${Object.keys(examples).join(' | ')}>`);
  process.exitCode = 1;
}

async function run(name: string): Promise<void> {
  const entry = examples[name];
  if (!entry) throw new Error(`Unknown example ${name}`);
  const example = await (await entry.load()).connect();
  try {
    await demo(example);
    console.log(`✓ ${name}`);
  } finally {
    await example.close();
  }
}

/** The same flow against every store: sign in, refresh, reuse detection, a refresh race, revocation. */
async function demo({ sessions, revocations }: StoreExample): Promise<void> {
  const auth = createAuth<{ role: string }>({
    // A throwaway secret; a real app sets TOKLYN_SECRET.
    ...accessTokensFromEnv({
      env: { TOKLYN_SECRET: randomBytes(32).toString('base64') },
    }),
    sessions,
    revocations,
    verification: 'online',
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 3600,
    sessionMaxAgeSeconds: 86_400,
  });
  const subject = `demo-${randomUUID()}`;

  const first = await auth.createSession({
    subject,
    claims: { role: 'admin' },
  });
  const claims = await auth.verifyAccessToken(first.accessToken);
  check(claims.role === 'admin', 'claims survive the round trip');

  const rotated = await auth.refresh({ refreshToken: first.refreshToken });
  check(rotated.refreshToken !== first.refreshToken, 'refresh rotates');
  await expectCode(
    auth.refresh({ refreshToken: first.refreshToken }),
    'refresh_token_reused',
    'replaying a spent refresh token is detected',
  );
  await expectCode(
    auth.verifyAccessToken(rotated.accessToken),
    'session_revoked',
    'reuse revoked the whole session',
  );

  const raced = await auth.createSession({ subject });
  const results = await Promise.allSettled(
    Array.from({ length: RACE_SIZE }, () =>
      auth.refresh({ refreshToken: raced.refreshToken }),
    ),
  );
  const winners = results.filter((result) => result.status === 'fulfilled');
  check(
    winners.length === 1,
    `exactly one of ${RACE_SIZE} parallel refreshes wins (got ${winners.length})`,
  );

  const current = await auth.createSession({ subject });
  await auth.revokeAccessToken(current.accessToken);
  await expectCode(
    auth.verifyAccessToken(current.accessToken),
    'access_token_revoked',
    'a single access token can be revoked',
  );

  await auth.revokeOtherSessions(subject, current.sessionId);
  const remaining = await auth.listSessions(subject);
  check(
    remaining.length === 1 && remaining[0]?.id === current.sessionId,
    'revokeOtherSessions keeps only the current session',
  );

  await auth.logout(current.refreshToken);
  check(
    (await auth.listSessions(subject)).length === 0,
    'logout ends the session',
  );
}

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`Failed: ${label}`);
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToklynError && error.code === code) return;
    throw new Error(`Failed: ${label}`, { cause: error });
  }
  throw new Error(`Failed: ${label} (no error)`);
}
