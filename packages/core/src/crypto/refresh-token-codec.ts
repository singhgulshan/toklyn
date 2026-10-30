import type { RefreshTokenCodec } from '#src/contracts.js';

const TOKEN_BYTES = 32;

/** 256-bit random tokens, stored as SHA-256 hex. Uses Web Crypto only. */
export class DefaultRefreshTokenCodec implements RefreshTokenCodec {
  async generate(): Promise<{ token: string; hash: string }> {
    const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    const token = toBase64Url(bytes);
    return { token, hash: await this.hash(token) };
  }

  async hash(token: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(token),
    );
    return toHex(new Uint8Array(digest));
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
