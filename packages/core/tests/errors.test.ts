import { describe, expect, it } from 'vitest';
import { ToklynError } from '#src/index.js';

describe('ToklynError', () => {
  it('carries a stable code and the original cause', () => {
    const cause = new Error('boom');
    const error = new ToklynError('storage_error', 'failed', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('storage_error');
    expect(error.cause).toBe(cause);
  });
});
