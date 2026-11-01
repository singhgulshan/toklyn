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

/** Sequelize binds `$1`, `$2`, ...; toklyn's MySQL and SQLite SQL uses `?` and no other `?`. */
export function toNumberedPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
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
 * The stores retry deadlocks (MySQL `errno` 1213, 1205) and busy databases (SQLite `code`
 * SQLITE_BUSY). Sequelize wraps driver errors, so copy those fields onto the error it throws.
 */
export function withDriverError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const driver = (error as { original?: { errno?: unknown; code?: unknown } })
    .original;
  if (!driver) return error;
  const wrapped = error as { errno?: unknown; code?: unknown };
  if (wrapped.errno === undefined && driver.errno !== undefined) {
    wrapped.errno = driver.errno;
  }
  if (wrapped.code === undefined && driver.code !== undefined) {
    wrapped.code = driver.code;
  }
  return error;
}
