import type { Clock } from '#src/contracts.js';

export const systemClock: Clock = { now: () => Date.now() };
