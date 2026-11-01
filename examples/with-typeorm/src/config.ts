import type { MySqlResult, MySqlRow } from '@toklyn/store/mysql';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to run this example`);
  return value;
}

/** The SQLite file, created next to package.json unless SQLITE_PATH is set. */
export function sqlitePath(): string {
  return process.env.SQLITE_PATH ?? 'toklyn-example.db';
}

/** Runs async tasks one at a time, in call order. */
export function serialized() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

/** A MySQL reply: rows for a `SELECT`, a header with `affectedRows` for a write. */
export function toMySqlResult(reply: unknown): MySqlResult {
  if (Array.isArray(reply)) {
    return { rows: reply as MySqlRow[], affectedRows: 0 };
  }
  const affectedRows = (reply as { affectedRows?: unknown } | null)
    ?.affectedRows;
  return { rows: [], affectedRows: Number(affectedRows ?? 0) };
}

/**
 * The MySQL store retries deadlocks by reading `errno` (1213, 1205). TypeORM wraps driver
 * errors, so copy the driver's `errno` onto the error it throws.
 */
export function withDriverErrno(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || 'errno' in error) {
    return error;
  }
  const errno = (error as { driverError?: { errno?: unknown } }).driverError
    ?.errno;
  return typeof errno === 'number' ? Object.assign(error, { errno }) : error;
}
