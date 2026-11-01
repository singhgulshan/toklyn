import type { Auth, AuthConfig } from '#src/auth.js';
import type { Clock } from '#src/contracts.js';
import { createAuth } from '#src/create-auth.js';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
} from '#src/crypto/jwt-access-tokens.js';
import { MemoryAccessTokenRevocationStore } from '#src/storage/memory-revocation-store.js';
import { MemorySessionStore } from '#src/storage/memory-store.js';
import type { ClaimsShape, CustomClaims } from '#src/types.js';

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(epochMs: number): void;
}

/** A clock that only moves when told to. Starts at `startAt`, or the current time. */
export function createTestClock(startAt: number = Date.now()): TestClock {
  let time = startAt;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    set: (epochMs) => {
      time = epochMs;
    },
  };
}

export type TestAuthOptions<TClaims extends ClaimsShape = CustomClaims> =
  Partial<Omit<AuthConfig<TClaims>, 'clock'>> & {
    /** Start time of the test clock, epoch ms. Defaults to now. */
    startAt?: number;
  };

export interface TestAuth<TClaims extends ClaimsShape = CustomClaims> {
  auth: Auth<TClaims>;
  clock: TestClock;
  sessions: AuthConfig<TClaims>['sessions'];
  revocations: NonNullable<AuthConfig<TClaims>['revocations']>;
}

/**
 * For tests only: a random HS256 key per call, in-memory stores and a test clock.
 * Defaults: access token 15 minutes, refresh token 1 day, session 7 days.
 */
export function createTestAuth<TClaims extends ClaimsShape = CustomClaims>(
  options: TestAuthOptions<TClaims> = {},
): TestAuth<TClaims> {
  const { startAt, ...overrides } = options;
  const clock = createTestClock(startAt);
  const keys = {
    keys: [
      {
        algorithm: 'HS256' as const,
        secret: crypto.getRandomValues(new Uint8Array(32)),
      },
    ],
  };
  const sessions = overrides.sessions ?? new MemorySessionStore();
  const revocations =
    overrides.revocations ?? new MemoryAccessTokenRevocationStore(clock);
  const auth = createAuth<TClaims>({
    signer: new JwtAccessTokenSigner(keys),
    verifier: new JwtAccessTokenVerifier(keys),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86_400,
    sessionMaxAgeSeconds: 7 * 86_400,
    ...overrides,
    sessions,
    revocations,
    clock,
  });
  return { auth, clock, sessions, revocations };
}
