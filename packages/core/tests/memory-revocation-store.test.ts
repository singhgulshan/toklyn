import { describe, expect, it } from 'vitest';
import { MemoryAccessTokenRevocationStore } from '#src/index.js';
import { revocationStoreContract } from '#src/testing/index.js';

revocationStoreContract(
  'MemoryAccessTokenRevocationStore',
  (clock) => new MemoryAccessTokenRevocationStore(clock),
);

class FakeClock {
  constructor(public time = 1_000_000) {}
  now = () => this.time;
}

describe('MemoryAccessTokenRevocationStore', () => {
  it('reports a revoked token until it expires', async () => {
    const clock = new FakeClock();
    const store = new MemoryAccessTokenRevocationStore(clock);

    await store.revoke('jti-1', clock.time + 1000);

    expect(await store.isRevoked('jti-1')).toBe(true);
    clock.time += 1000;
    expect(await store.isRevoked('jti-1')).toBe(false);
  });

  it('does not report tokens it was never given', async () => {
    const store = new MemoryAccessTokenRevocationStore(new FakeClock());

    expect(await store.isRevoked('unknown')).toBe(false);
  });

  it('keeps live entries while dropping expired ones in bulk', async () => {
    const clock = new FakeClock();
    const store = new MemoryAccessTokenRevocationStore(clock);

    for (let i = 0; i < 3000; i += 1) {
      await store.revoke(`short-${i}`, clock.time + 10);
    }
    clock.time += 100;
    await store.revoke('long', clock.time + 60_000);
    for (let i = 0; i < 3000; i += 1) {
      await store.revoke(`later-${i}`, clock.time + 60_000);
    }

    expect(await store.isRevoked('long')).toBe(true);
    expect(await store.isRevoked('later-2999')).toBe(true);
    expect(await store.isRevoked('short-0')).toBe(false);
  });
});
