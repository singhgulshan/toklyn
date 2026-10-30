export type ToklynErrorCode =
  | 'invalid_config'
  | 'invalid_input'
  | 'invalid_access_token'
  | 'access_token_expired'
  | 'access_token_revoked'
  | 'invalid_refresh_token'
  | 'refresh_token_expired'
  | 'refresh_token_reused'
  | 'session_not_found'
  | 'session_expired'
  | 'session_revoked'
  | 'storage_error';

export class ToklynError extends Error {
  readonly code: ToklynErrorCode;

  constructor(
    code: ToklynErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ToklynError';
    this.code = code;
  }
}
