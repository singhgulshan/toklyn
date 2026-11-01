import { randomBytes, randomUUID } from 'node:crypto';
import { ToklynError, accessTokensFromEnv, createAuth } from 'toklyn';
import type { AccessTokenRevocationStore, SessionStore } from 'toklyn';

/** The two stores toklyn needs, built from your database connection in `src/stores/`. */
export interface Stores {
  sessions: SessionStore;
  revocations: AccessTokenRevocationStore;
  close(): Promise<void>;
}

interface AppClaims {
  role: string;
}

/**
 * The core of toklyn on your database: sign in, verify, rotate, detect a stolen refresh
 * token, survive parallel refreshes, list and revoke sessions, sign out.
 */
export async function walkthrough({
  sessions,
  revocations,
}: Stores): Promise<void> {
  // Once at startup. TOKLYN_SECRET comes from your secret manager (openssl rand -base64 32).
  const auth = createAuth<AppClaims>({
    ...accessTokensFromEnv({
      env: {
        TOKLYN_SECRET:
          process.env.TOKLYN_SECRET ?? randomBytes(32).toString('base64'),
      },
    }),
    sessions,
    revocations,
    // `online` also checks the session and the revocation list on every verify.
    verification: 'online',
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
    sessionMaxAgeSeconds: 30 * 24 * 60 * 60,
  });
  const userId = `user-${randomUUID()}`;

  // 1. Sign in, after your own password check. Send the access token in the response body
  //    and the refresh token as an HttpOnly cookie (the framework adapters do both).
  const signIn = await auth.createSession({
    subject: userId,
    claims: { role: 'member' },
    metadata: { device: 'laptop' },
  });
  step('1. signed in', `session ${signIn.sessionId}`);

  // 2. On every request: verify the access token and read your claims from it.
  const claims = await auth.verifyAccessToken(signIn.accessToken);
  check(claims.sub === userId && claims.role === 'member', 'claims');
  step('2. verified', `sub=${claims.sub} role=${claims.role}`);

  // 3. When the access token expires: rotate. The old refresh token is now spent.
  const rotated = await auth.refresh({ refreshToken: signIn.refreshToken });
  check(rotated.refreshToken !== signIn.refreshToken, 'rotation');
  step('3. rotated', 'new access token and new refresh token');

  // 4. A role change reaches the next access token by passing new claims to refresh.
  const promoted = await auth.refresh({
    refreshToken: rotated.refreshToken,
    claims: { role: 'admin' },
  });
  const promotedClaims = await auth.verifyAccessToken(promoted.accessToken);
  check(promotedClaims.role === 'admin', 'claims update');
  step('4. claims updated', `role=${promotedClaims.role}`);

  // 5. Someone replays a spent refresh token (a stolen copy): the whole session is revoked,
  //    so the attacker and the user are both signed out.
  await expectError(
    auth.refresh({ refreshToken: signIn.refreshToken }),
    'refresh_token_reused',
  );
  await expectError(
    auth.verifyAccessToken(promoted.accessToken),
    'session_revoked',
  );
  step('5. reuse detected', 'session revoked');

  // 6. One refresh token sent many times at once (two tabs, a retry): rotation is atomic,
  //    so exactly one request gets new tokens. With strict reuse detection (the default,
  //    `reuseGraceMs: 0`) the others count as reuse and end the session. So refresh one at
  //    a time on the client, or allow a short grace window with `reuseGraceMs`.
  const tablet = await auth.createSession({
    subject: userId,
    claims: { role: 'admin' },
    metadata: { device: 'tablet' },
  });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      auth.refresh({ refreshToken: tablet.refreshToken }),
    ),
  );
  const winners = results.filter((result) => result.status === 'fulfilled');
  check(winners.length === 1, `one refresh wins, got ${winners.length}`);
  step('6. parallel refresh', '1 of 10 won, the rest ended the session');

  // 7. "Your devices": list the user's sessions and sign out everywhere else.
  const laptop = await auth.createSession({
    subject: userId,
    claims: { role: 'admin' },
    metadata: { device: 'laptop' },
  });
  await auth.createSession({
    subject: userId,
    claims: { role: 'admin' },
    metadata: { device: 'phone' },
  });
  const devices = await auth.listSessions(userId);
  check(devices.length === 2, 'two active sessions');
  await auth.revokeOtherSessions(userId, laptop.sessionId);
  const remaining = await auth.listSessions(userId);
  check(
    remaining.length === 1 && remaining[0]?.id === laptop.sessionId,
    'revoke other sessions',
  );
  step(
    '7. other devices signed out',
    `${devices.length} sessions -> ${remaining.length}`,
  );

  // 8. Revoke one access token right away, e.g. after a password change on this device.
  await auth.revokeAccessToken(laptop.accessToken);
  await expectError(
    auth.verifyAccessToken(laptop.accessToken),
    'access_token_revoked',
  );
  step('8. access token revoked', 'rejected before it expires');

  // 9. Sign out: the refresh token's session ends.
  await auth.logout(laptop.refreshToken);
  check((await auth.listSessions(userId)).length === 0, 'logout');
  step('9. signed out', 'no active sessions left');
}

function step(name: string, detail: string): void {
  console.log(`   ${name.padEnd(30)} ${detail}`);
}

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`Check failed: ${label}`);
}

async function expectError(
  promise: Promise<unknown>,
  code: ToklynError['code'],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToklynError && error.code === code) return;
    throw new Error(`Expected ${code}`, { cause: error });
  }
  throw new Error(`Expected ${code}, but it succeeded`);
}
