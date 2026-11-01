import type { MySqlResult, MySqlRow } from '@toklyn/store/mysql';
import type { AccessTokenRevocationStore, SessionStore } from 'toklyn';

/** What every example returns: the two stores, wired to the app's own connection. */
export interface StoreExample {
  sessions: SessionStore;
  revocations: AccessTokenRevocationStore;
  close(): Promise<void>;
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to run this example`);
  return value;
}

/** `mysql://user:password@host:port/database` as connection options, for drivers that take an object. */
export function mysqlOptions(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
  };
}

/** For ORMs that take `$1`, `$2`, ... while toklyn's MySQL SQL uses `?`. It has no other `?`. */
export function toNumberedPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/** For ORMs that take `?` while toklyn's PostgreSQL SQL uses `$1`, `$2`, ... */
export function toPositionalPlaceholders(
  text: string,
  params: readonly (string | null)[],
): { sql: string; bindings: (string | null)[] } {
  const bindings: (string | null)[] = [];
  const sql = text.replace(/\$(\d+)/g, (_, index: string) => {
    bindings.push(params[Number(index) - 1] ?? null);
    return '?';
  });
  return { sql, bindings };
}

/** A MySQL driver reply: rows for a `SELECT`, a result header with `affectedRows` for a write. */
export function toMySqlResult(reply: unknown): MySqlResult {
  if (Array.isArray(reply)) {
    return { rows: reply as MySqlRow[], affectedRows: 0 };
  }
  const affectedRows = (reply as { affectedRows?: unknown } | null)
    ?.affectedRows;
  return { rows: [], affectedRows: Number(affectedRows ?? 0) };
}

/**
 * The MySQL store retries deadlocks by reading `errno` (1213, 1205) from the error. ORMs wrap
 * driver errors, so copy the driver's `errno` onto the error they throw.
 */
export function withDriverErrno(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || 'errno' in error) {
    return error;
  }
  const wrapped = error as {
    original?: { errno?: unknown };
    parent?: { errno?: unknown };
    driverError?: { errno?: unknown };
    cause?: { errno?: unknown };
  };
  const errno =
    wrapped.original?.errno ??
    wrapped.parent?.errno ??
    wrapped.driverError?.errno ??
    wrapped.cause?.errno;
  return typeof errno === 'number' ? Object.assign(error, { errno }) : error;
}
