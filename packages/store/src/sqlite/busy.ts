const SQLITE_BUSY = 5;
const MAX_ATTEMPTS = 10;
const MAX_DELAY_MS = 50;

/** Retries `fn` while another connection holds the write lock (`SQLITE_BUSY`), with jittered backoff. */
export async function retryWhenBusy<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isBusy(error)) throw error;
      const delay = Math.random() * Math.min(2 ** attempt, MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** `code` 'SQLITE_BUSY*' (better-sqlite3, Bun, libSQL) or a numeric code (`node:sqlite` errcode). */
export function isBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errcode, errno, rawCode } = error as Record<string, unknown>;
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return true;
  // Extended result codes keep the primary code in the low byte.
  return [errcode, errno, rawCode].some(
    (value) =>
      typeof value === 'number' && value > 0 && (value & 0xff) === SQLITE_BUSY,
  );
}
