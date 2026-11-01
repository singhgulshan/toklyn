import type { CustomClaims, Session, SessionMetadata } from 'toklyn';
import { replyParsers } from '#src/shared/reply.js';
import type { SqliteRow } from '#src/sqlite/client.js';

const parsers = replyParsers('SQLite');

export const { malformed } = parsers;

/** Parses integers selected as text: epoch ms. */
export const { parseInteger } = parsers;

const { parseJsonObject } = parsers;

/** A ms parameter, sent as text and stored as an integer. */
export const MS = 'CAST(? AS INTEGER)';

/** Columns read by `parseSession`; integers as text so every driver returns strings. */
export const sessionColumns = (table = '') =>
  `${table}id AS id, ${table}subject AS subject,
  ${table}claims AS claims, ${table}metadata AS metadata,
  CAST(${table}created_at AS TEXT) AS created_at,
  CAST(${table}last_refreshed_at AS TEXT) AS last_refreshed_at,
  CAST(${table}expires_at AS TEXT) AS expires_at,
  CAST(${table}revoked_at AS TEXT) AS revoked_at`;

export function parseSession(row: SqliteRow): Session {
  return {
    id: text(row, 'id'),
    subject: text(row, 'subject'),
    claims: parseJsonObject(text(row, 'claims')) as CustomClaims,
    metadata: parseJsonObject(text(row, 'metadata')) as SessionMetadata,
    createdAt: parseInteger(row['created_at']),
    lastRefreshedAt: parseInteger(row['last_refreshed_at']),
    expiresAt: parseInteger(row['expires_at']),
    revokedAt: nullableInteger(row['revoked_at']),
  };
}

export function nullableInteger(value: unknown): number | null {
  return value === null ? null : parseInteger(value);
}

export function nullableString(value: number | null): string | null {
  return value === null ? null : String(value);
}

function text(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw malformed();
  return value;
}
