import { ToklynError } from 'toklyn';
import type { SqliteClient } from '#src/sqlite/client.js';

export interface SqliteSchemaOptions {
  /** Prefix for table and index names. Default `toklyn_`. */
  tablePrefix?: string;
}

export const DEFAULT_TABLE_PREFIX = 'toklyn_';

// Same limit as the other SQL stores.
const MAX_PREFIX_LENGTH = 24;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Quoted, ready-to-interpolate table names. */
export interface TableNames {
  sessions: string;
  refreshTokens: string;
  revocations: string;
}

function validPrefix({
  tablePrefix = DEFAULT_TABLE_PREFIX,
}: SqliteSchemaOptions): string {
  if (
    tablePrefix !== '' &&
    !(IDENTIFIER.test(tablePrefix) && tablePrefix.length <= MAX_PREFIX_LENGTH)
  ) {
    throw new ToklynError(
      'invalid_config',
      `tablePrefix must be at most ${MAX_PREFIX_LENGTH} lowercase letters, digits or underscores, not starting with a digit`,
    );
  }
  return tablePrefix;
}

export function resolveTables(options: SqliteSchemaOptions = {}): TableNames {
  const prefix = validPrefix(options);
  return {
    sessions: `"${prefix}sessions"`,
    refreshTokens: `"${prefix}refresh_tokens"`,
    revocations: `"${prefix}access_token_revocations"`,
  };
}

// STRICT tables reject values of the wrong type. TEXT compares byte by byte (BINARY collation).
// The foreign key cascades only where `PRAGMA foreign_keys = ON`; the store never relies on it.
function schemaStatements(options: SqliteSchemaOptions = {}): string[] {
  const prefix = validPrefix(options);
  const tables = resolveTables(options);
  const index = (name: string, table: string, column: string) =>
    `CREATE INDEX IF NOT EXISTS "${prefix}${name}" ON ${table} (${column})`;
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.sessions} (
  id TEXT NOT NULL PRIMARY KEY,
  subject TEXT NOT NULL,
  claims TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_refreshed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT`,
    index('sessions_subject_idx', tables.sessions, 'subject'),
    index('sessions_expires_at_idx', tables.sessions, 'expires_at'),
    `CREATE TABLE IF NOT EXISTS ${tables.refreshTokens} (
  hash TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ${tables.sessions} (id) ON DELETE CASCADE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT`,
    index('refresh_tokens_session_id_idx', tables.refreshTokens, 'session_id'),
    `CREATE TABLE IF NOT EXISTS ${tables.revocations} (
  jti TEXT NOT NULL PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT`,
    index(
      'access_token_revocations_expires_at_idx',
      tables.revocations,
      'expires_at',
    ),
  ];
}

/** The DDL for your own migration tool. Safe to run more than once. Needs SQLite 3.37+. */
export function createSchemaSql(options?: SqliteSchemaOptions): string {
  return schemaStatements(options)
    .map((statement) => `${statement};\n`)
    .join('\n');
}

/** Creates the tables and indexes if missing, in one transaction. */
export async function migrate(
  client: SqliteClient,
  options?: SqliteSchemaOptions,
): Promise<void> {
  const statements = schemaStatements(options);
  await client.transaction(async (tx) => {
    for (const statement of statements) await tx.run(statement, []);
  });
}
