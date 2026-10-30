const MAX_AUTHORIZATION_LENGTH = 8192;
// RFC 6750: case-insensitive scheme, one or more spaces, then a token68.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

/** Returns the token from an `Authorization: Bearer <token>` header, or null if malformed. */
export function extractBearerToken(
  header: string | null | undefined,
): string | null {
  if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_LENGTH) {
    return null;
  }
  return BEARER.exec(header)?.[1] ?? null;
}
