import { systemClock } from '#src/clock.js';
import type { AccessTokenRevocationStore, Clock } from '#src/contracts.js';

const MIN_SWEEP_SIZE = 1024;

/** In-process denylist for development and tests. State is lost on restart. */
export class MemoryAccessTokenRevocationStore implements AccessTokenRevocationStore {
  private readonly entries = new Map<string, number>();
  private sweepAtSize = MIN_SWEEP_SIZE;

  constructor(private readonly clock: Clock = systemClock) {}

  async revoke(jti: string, expiresAt: number): Promise<void> {
    this.entries.set(jti, expiresAt);
    // Doubling the threshold keeps the cost of dropping expired entries amortized O(1).
    if (this.entries.size >= this.sweepAtSize) {
      const now = this.clock.now();
      for (const [id, expiry] of this.entries) {
        if (expiry <= now) this.entries.delete(id);
      }
      this.sweepAtSize = Math.max(MIN_SWEEP_SIZE, this.entries.size * 2);
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    const expiry = this.entries.get(jti);
    if (expiry === undefined) return false;
    if (expiry > this.clock.now()) return true;
    this.entries.delete(jti);
    return false;
  }
}
