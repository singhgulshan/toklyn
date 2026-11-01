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

/** knex binds `?`; toklyn's PostgreSQL SQL uses `$1`, `$2`, ... and no other `?`. */
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

/** A MySQL reply: rows for a `SELECT`, a header with `affectedRows` for a write. */
export function toMySqlResult(reply: unknown): MySqlResult {
  if (Array.isArray(reply)) {
    return { rows: reply as MySqlRow[], affectedRows: 0 };
  }
  const affectedRows = (reply as { affectedRows?: unknown } | null)
    ?.affectedRows;
  return { rows: [], affectedRows: Number(affectedRows ?? 0) };
}
