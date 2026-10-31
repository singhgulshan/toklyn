import { ToklynError } from 'toklyn';
import type { PostgresClient } from '#src/postgres/client.js';

export interface PostgresSchemaOptions {
  /** Postgres schema for the tables. Default: the connection's `search_path`, usually `public`. */
  schema?: string;
  /** Prefix for table and index names. Default `toklyn_`. */
  tablePrefix?: string;
}

export const DEFAULT_TABLE_PREFIX = 'toklyn_';

// The longest derived name is `<prefix>access_token_revocations_expires_at_idx` (39 chars);
// Postgres silently truncates identifiers past 63 bytes.
const MAX_PREFIX_LENGTH = 24;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Quoted, ready-to-interpolate table names. */
export interface TableNames {
  sessions: string;
  refreshTokens: string;
  revocations: string;
}

interface ResolvedNames {
  schema: string | null;
  prefix: string;
  tables: TableNames;
}

export function resolveNames({
  schema,
  tablePrefix = DEFAULT_TABLE_PREFIX,
}: PostgresSchemaOptions = {}): ResolvedNames {
  if (
    schema !== undefined &&
    !(IDENTIFIER.test(schema) && schema.length <= 63)
  ) {
    throw invalidConfig(
      'schema must be 1-63 lowercase letters, digits or underscores, not starting with a digit',
    );
  }
  if (
    tablePrefix !== '' &&
    !(IDENTIFIER.test(tablePrefix) && tablePrefix.length <= MAX_PREFIX_LENGTH)
  ) {
    throw invalidConfig(
      `tablePrefix must be at most ${MAX_PREFIX_LENGTH} lowercase letters, digits or underscores, not starting with a digit`,
    );
  }
  const qualify = (table: string) =>
    schema === undefined
      ? `"${tablePrefix}${table}"`
      : `"${schema}"."${tablePrefix}${table}"`;
  return {
    schema: schema ?? null,
    prefix: tablePrefix,
    tables: {
      sessions: qualify('sessions'),
      refreshTokens: qualify('refresh_tokens'),
      revocations: qualify('access_token_revocations'),
    },
  };
}

function schemaStatements(options?: PostgresSchemaOptions): string[] {
  const { schema, prefix, tables } = resolveNames(options);
  const index = (name: string) => `"${prefix}${name}"`;
  return [
    ...(schema === null ? [] : [`CREATE SCHEMA IF NOT EXISTS "${schema}"`]),
    `CREATE TABLE IF NOT EXISTS ${tables.sessions} (
  id text PRIMARY KEY,
  subject text NOT NULL,
  claims jsonb NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  last_refreshed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
)`,
    `CREATE INDEX IF NOT EXISTS ${index('sessions_subject_idx')} ON ${tables.sessions} (subject)`,
    `CREATE INDEX IF NOT EXISTS ${index('sessions_expires_at_idx')} ON ${tables.sessions} (expires_at)`,
    `CREATE TABLE IF NOT EXISTS ${tables.refreshTokens} (
  hash text PRIMARY KEY,
  session_id text NOT NULL REFERENCES ${tables.sessions} (id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
)`,
    `CREATE INDEX IF NOT EXISTS ${index('refresh_tokens_session_id_idx')} ON ${tables.refreshTokens} (session_id)`,
    `CREATE TABLE IF NOT EXISTS ${tables.revocations} (
  jti text PRIMARY KEY,
  expires_at timestamptz NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS ${index('access_token_revocations_expires_at_idx')} ON ${tables.revocations} (expires_at)`,
  ];
}

/** The DDL for your own migration tool. Safe to run more than once. */
export function createSchemaSql(options?: PostgresSchemaOptions): string {
  return schemaStatements(options)
    .map((statement) => `${statement};\n`)
    .join('\n');
}

/**
 * Creates the schema, tables and indexes if missing. Run it from one place, such as a
 * deploy step, not from every instance at startup: concurrent `CREATE ... IF NOT EXISTS` can fail.
 */
export async function migrate(
  client: PostgresClient,
  options?: PostgresSchemaOptions,
): Promise<void> {
  for (const statement of schemaStatements(options)) {
    await client.query(statement, []);
  }
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}
