import { describe, expect, it } from 'vitest';
import type { AccessTokenRevocationStore, Clock } from '#src/contracts.js';

export interface ControllableClock extends Clock {
  advance(ms: number): void;
}

/** The factory must build a store that reads time from the given clock. */
export type RevocationStoreFactory = (
  clock: ControllableClock,
) => AccessTokenRevocationStore;

const T0 = 1_000_000;
const MINUTE = 60_000;

function createClock(): ControllableClock {
  let time = T0;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

export function revocationStoreContract(
  name: string,
  factory: RevocationStoreFactory,
): void {
  describe(`${name} (AccessTokenRevocationStore contract)`, () => {
    function setup() {
      const clock = createClock();
      return { clock, store: factory(clock) };
    }

    it('does not report tokens it was never given', async () => {
      const { store } = setup();

      expect(await store.isRevoked('unknown')).toBe(false);
    });

    it('reports a revoked token while it is still valid', async () => {
      const { clock, store } = setup();

      await store.revoke('jti-1', clock.now() + MINUTE);

      expect(await store.isRevoked('jti-1')).toBe(true);
    });

    it('stops reporting a token once it expires', async () => {
      const { clock, store } = setup();
      await store.revoke('jti-1', clock.now() + MINUTE);

      clock.advance(MINUTE);

      expect(await store.isRevoked('jti-1')).toBe(false);
    });

    it('keeps tokens independent of each other', async () => {
      const { clock, store } = setup();

      await store.revoke('jti-1', clock.now() + MINUTE);

      expect(await store.isRevoked('jti-2')).toBe(false);
    });

    it('is idempotent', async () => {
      const { clock, store } = setup();

      await store.revoke('jti-1', clock.now() + MINUTE);
      await store.revoke('jti-1', clock.now() + MINUTE);

      expect(await store.isRevoked('jti-1')).toBe(true);
    });

    it('ignores an entry that is already expired', async () => {
      const { clock, store } = setup();

      await store.revoke('jti-1', clock.now() - 1);

      expect(await store.isRevoked('jti-1')).toBe(false);
    });

    it('handles concurrent revocations', async () => {
      const { clock, store } = setup();
      const ids = Array.from({ length: 50 }, (_, i) => `jti-${i}`);

      await Promise.all(
        ids.map((id) => store.revoke(id, clock.now() + MINUTE)),
      );

      const results = await Promise.all(ids.map((id) => store.isRevoked(id)));
      expect(results.every(Boolean)).toBe(true);
    });
  });
}
