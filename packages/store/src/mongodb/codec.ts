import { ToklynError } from 'toklyn';
import type { CustomClaims, Session, SessionMetadata } from 'toklyn';
import type { MongoDocument } from '#src/mongodb/client.js';
import { replyParsers } from '#src/shared/reply.js';

const parsers = replyParsers('MongoDB');

export const { malformed } = parsers;

const { parseJsonObject } = parsers;

/** Session fields without the token arrays. */
export const SESSION_FIELDS = {
  _id: 1,
  subject: 1,
  claims: 1,
  metadata: 1,
  createdAt: 1,
  lastRefreshedAt: 1,
  expiresAt: 1,
  revokedAt: 1,
  version: 1,
} as const;

/** Rejects non-string input before it reaches a query, where an object could act as an operator. */
export function checkString(name: string, value: unknown): void {
  if (typeof value !== 'string') {
    throw new ToklynError('invalid_input', `The ${name} must be a string`);
  }
}

export function parseSession(document: MongoDocument): Session {
  return {
    id: text(document['_id']),
    subject: text(document['subject']),
    claims: parseJsonObject(text(document['claims'])) as CustomClaims,
    metadata: parseJsonObject(text(document['metadata'])) as SessionMetadata,
    createdAt: integer(document['createdAt']),
    lastRefreshedAt: integer(document['lastRefreshedAt']),
    expiresAt: integer(document['expiresAt']),
    revokedAt: nullableInteger(document['revokedAt']),
  };
}

export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw malformed();
  }
  return value;
}

export function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw malformed();
  return value;
}
