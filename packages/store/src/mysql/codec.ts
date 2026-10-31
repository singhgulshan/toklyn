import { ToklynError } from 'toklyn';
import type { CustomClaims, Session, SessionMetadata } from 'toklyn';
import type { MySqlRow } from '#src/mysql/client.js';
import { replyParsers } from '#src/shared/reply.js';

const parsers = replyParsers('MySQL');

export const { malformed } = parsers;

/** Parses integers selected as text: epoch ms. */
export const { parseInteger } = parsers;

const { parseJsonObject } = parsers;

/** A ms parameter compared as an integer, not as a double. */
export const MS = 'CAST(? AS SIGNED)';

/** Key columns are VARBINARY(255). */
const MAX_KEY_BYTES = 255;
const encoder = new TextEncoder();

/** Rejects a key that a non-strict server would silently truncate. */
export function checkKey(name: string, value: string): void {
  if (encoder.encode(value).length > MAX_KEY_BYTES) {
    throw new ToklynError(
      'invalid_input',
      `The ${name} must be at most ${MAX_KEY_BYTES} bytes`,
    );
  }
}

/** Columns read by `parseSession`; binary keys and BIGINTs as text so every driver returns strings. */
export const sessionColumns = (table = '') =>
  `CONVERT(${table}id USING utf8mb4) AS id,
  CONVERT(${table}subject USING utf8mb4) AS subject,
  ${table}claims AS claims, ${table}metadata AS metadata,
  CAST(${table}created_at AS CHAR) AS created_at,
  CAST(${table}last_refreshed_at AS CHAR) AS last_refreshed_at,
  CAST(${table}expires_at AS CHAR) AS expires_at,
  CAST(${table}revoked_at AS CHAR) AS revoked_at`;

export function parseSession(row: MySqlRow): Session {
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

export function text(row: MySqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw malformed();
  return value;
}
