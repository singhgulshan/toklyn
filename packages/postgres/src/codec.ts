import { ToklynError } from 'toklyn';
import type { CustomClaims, Session, SessionMetadata } from 'toklyn';
import type { PostgresRow } from '#src/client.js';

/** Epoch ms parameter (`$n`, sent as text) to `timestamptz`, without float rounding. */
export const toTimestamp = (param: string) =>
  `(timestamptz 'epoch' + ${param}::bigint * interval '1 millisecond')`;

/** `timestamptz` column to epoch ms as text, so no driver turns it into a Date or BigInt. */
export const toEpochMs = (column: string) =>
  `(extract(epoch from ${column}) * 1000)::bigint::text`;

/** Columns read by `parseSession`; jsonb as text so every driver returns the same thing. */
export const SESSION_COLUMNS = `id, subject, claims::text AS claims, metadata::text AS metadata,
  ${toEpochMs('created_at')} AS created_at,
  ${toEpochMs('last_refreshed_at')} AS last_refreshed_at,
  ${toEpochMs('expires_at')} AS expires_at,
  ${toEpochMs('revoked_at')} AS revoked_at`;

export function parseSession(row: PostgresRow): Session {
  return {
    id: text(row, 'id'),
    subject: text(row, 'subject'),
    claims: parseJsonObject(text(row, 'claims')) as CustomClaims,
    metadata: parseJsonObject(text(row, 'metadata')) as SessionMetadata,
    createdAt: parseInteger(row['created_at']),
    lastRefreshedAt: parseInteger(row['last_refreshed_at']),
    expiresAt: parseInteger(row['expires_at']),
    revokedAt:
      row['revoked_at'] === null ? null : parseInteger(row['revoked_at']),
  };
}

/** Parses integers selected as text: epoch ms and counts. */
export function parseInteger(value: unknown): number {
  const parsed =
    typeof value === 'string' && value !== '' ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw malformed();
  return parsed;
}

export function text(row: PostgresRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw malformed();
  return value;
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw malformed(cause);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformed();
  }
  return parsed as Record<string, unknown>;
}

export function malformed(cause?: unknown): ToklynError {
  return new ToklynError('storage_error', 'Unexpected reply from Postgres', {
    cause,
  });
}
