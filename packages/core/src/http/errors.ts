import { ToklynError } from '#src/errors.js';
import type { ToklynErrorCode } from '#src/errors.js';

export interface ToklynHttpError {
  status: 401 | 503;
  body: { error: 'unauthorized' | 'service_unavailable' };
}

// Every authentication failure looks the same to the client, so responses leak nothing.
const UNAUTHORIZED = new Set<ToklynErrorCode>([
  'invalid_access_token',
  'access_token_expired',
  'access_token_revoked',
  'invalid_refresh_token',
  'refresh_token_expired',
  'refresh_token_reused',
  'session_not_found',
  'session_expired',
  'session_revoked',
]);

/** Maps auth failures to 401 and storage failures to 503. Returns null for anything else. */
export function toToklynHttpError(error: unknown): ToklynHttpError | null {
  if (!(error instanceof ToklynError)) return null;
  if (UNAUTHORIZED.has(error.code)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  if (error.code === 'storage_error') {
    return { status: 503, body: { error: 'service_unavailable' } };
  }
  return null;
}
