import type { CustomClaims, Session, SessionMetadata } from 'toklyn';
import { replyParsers } from '#src/shared/reply.js';

const parsers = replyParsers('Redis');

export const { malformed, parseInteger: parseTimestamp } = parsers;

const { parseJsonObject } = parsers;

export function serializeTimestamp(value: number | null): string {
  return value === null ? '' : String(value);
}

/** Parses an HGETALL reply. Returns null for a missing key. */
export function parseSession(reply: unknown): Session | null {
  if (reply === null || (Array.isArray(reply) && reply.length === 0)) {
    return null;
  }
  const fields = parseHash(reply);
  const createdAt = parseTimestamp(field(fields, 'createdAt'));
  // Sessions written by 0.1.0 have no lastRefreshedAt.
  const lastRefreshedAt = fields.get('lastRefreshedAt');
  return {
    id: field(fields, 'id'),
    subject: field(fields, 'subject'),
    claims: parseJsonObject(field(fields, 'claims')) as CustomClaims,
    metadata: parseJsonObject(field(fields, 'metadata')) as SessionMetadata,
    createdAt,
    lastRefreshedAt:
      lastRefreshedAt === undefined
        ? createdAt
        : parseTimestamp(lastRefreshedAt),
    expiresAt: parseTimestamp(field(fields, 'expiresAt')),
    revokedAt: parseNullableTimestamp(field(fields, 'revokedAt')),
  };
}

export function parseSessionList(reply: unknown): Session[] {
  if (!Array.isArray(reply)) throw malformed();
  return reply.map((item) => {
    const session = parseSession(item);
    if (!session) throw malformed();
    return session;
  });
}

function parseNullableTimestamp(value: string): number | null {
  return value === '' ? null : parseTimestamp(value);
}

function parseHash(reply: unknown): Map<string, string> {
  if (!Array.isArray(reply) || reply.length % 2 !== 0) throw malformed();
  const fields = new Map<string, string>();
  for (let i = 0; i < reply.length; i += 2) {
    const key: unknown = reply[i];
    const value: unknown = reply[i + 1];
    if (typeof key !== 'string' || typeof value !== 'string') throw malformed();
    fields.set(key, value);
  }
  return fields;
}

function field(fields: Map<string, string>, name: string): string {
  const value = fields.get(name);
  if (value === undefined) throw malformed();
  return value;
}
