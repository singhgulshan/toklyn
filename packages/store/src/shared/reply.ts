import { ToklynError } from 'toklyn';

export interface ReplyParsers {
  malformed(cause?: unknown): ToklynError;
  /** Parses a safe integer sent as a decimal string, such as epoch ms. */
  parseInteger(value: unknown): number;
  /** Parses a JSON object, such as stored claims or metadata. */
  parseJsonObject(value: string): Record<string, unknown>;
}

/** Parsers that reject anything unexpected with `storage_error`, so a bad reply never passes as valid. */
export function replyParsers(backend: string): ReplyParsers {
  const malformed = (cause?: unknown): ToklynError =>
    new ToklynError('storage_error', `Unexpected reply from ${backend}`, {
      cause,
    });
  return {
    malformed,
    parseInteger(value) {
      const parsed =
        typeof value === 'string' && value !== '' ? Number(value) : NaN;
      if (!Number.isSafeInteger(parsed)) throw malformed();
      return parsed;
    },
    parseJsonObject(value) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (cause) {
        throw malformed(cause);
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw malformed();
      }
      return parsed as Record<string, unknown>;
    },
  };
}
