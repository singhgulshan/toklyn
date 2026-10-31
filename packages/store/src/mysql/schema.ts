import { ToklynError } from 'toklyn';
import type { MySqlExecutor } from '#src/mysql/client.js';

export interface MySqlSchemaOptions {
  /** Database holding the tables. Default: the connection's current database. */
  database?: string;
  /** Prefix for table names. Default `toklyn_`. */
  tablePrefix?: string;
}

export const DEFAULT_TABLE_PREFIX = 'toklyn_';

// Same limit as the Postgres store, well under MySQL's 64-character table names.
const MAX_PREFIX_LENGTH = 24;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Quoted, ready-to-interpolate table names. */
export interface TableNames {
  sessions: string;
  refreshTokens: string;
  revocations: string;
}

export function resolveTables({
  database,
  tablePrefix = DEFAULT_TABLE_PREFIX,
}: MySqlSchemaOptions = {}): TableNames {
  if (
    database !== undefined &&
    !(IDENTIFIER.test(database) && database.length <= 64)
  ) {
    throw invalidConfig(
      'database must be 1-64 lowercase letters, digits or underscores, not starting with a digit',
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
    database === undefined
      ? `\`${tablePrefix}${table}\``
      : `\`${database}\`.\`${tablePrefix}${table}\``;
  return {
    sessions: qualify('sessions'),
    refreshTokens: qualify('refresh_tokens'),
    revocations: qualify('access_token_revocations'),
  };
}

// Keys are VARBINARY: exact byte comparison, no case folding or trailing-space padding.
function schemaStatements(options?: MySqlSchemaOptions): string[] {
  const tables = resolveTables(options);
  return [
    `CREATE TABLE IF NOT EXISTS ${tables.sessions} (
  id VARBINARY(255) NOT NULL,
  subject VARBINARY(255) NOT NULL,
  claims MEDIUMTEXT NOT NULL,
  metadata MEDIUMTEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_refreshed_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT NULL,
  PRIMARY KEY (id),
  KEY subject_idx (subject),
  KEY expires_at_idx (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ${tables.refreshTokens} (
  hash VARBINARY(255) NOT NULL,
  session_id VARBINARY(255) NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT NULL,
  PRIMARY KEY (hash),
  KEY session_id_idx (session_id),
  FOREIGN KEY (session_id) REFERENCES ${tables.sessions} (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ${tables.revocations} (
  jti VARBINARY(255) NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (jti),
  KEY expires_at_idx (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];
}

/** The DDL for your own migration tool. Safe to run more than once. */
export function createSchemaSql(options?: MySqlSchemaOptions): string {
  return schemaStatements(options)
    .map((statement) => `${statement};\n`)
    .join('\n');
}

/** Creates the tables if missing. The database must already exist. Run it from one place, such as a deploy step. */
export async function migrate(
  client: MySqlExecutor,
  options?: MySqlSchemaOptions,
): Promise<void> {
  for (const statement of schemaStatements(options)) {
    await client.query(statement, []);
  }
}

function invalidConfig(message: string): ToklynError {
  return new ToklynError('invalid_config', message);
}
