import { describe, expect, it } from 'vitest';
import { DefaultRefreshTokenCodec } from '#src/index.js';

const codec = new DefaultRefreshTokenCodec();

describe('DefaultRefreshTokenCodec', () => {
  it('generates url-safe tokens carrying 256 bits of randomness', async () => {
    const { token } = await codec.generate();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats a token', async () => {
    const generated = await Promise.all(
      Array.from({ length: 500 }, () => codec.generate()),
    );

    expect(new Set(generated.map((g) => g.token)).size).toBe(500);
    expect(new Set(generated.map((g) => g.hash)).size).toBe(500);
  });

  it('returns the hash that hash() computes for the token', async () => {
    const { token, hash } = await codec.generate();

    expect(await codec.hash(token)).toBe(hash);
  });

  it('hashes to a fixed-length hex digest that is not the token', async () => {
    const { token, hash } = await codec.generate();

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('matches the known SHA-256 of a fixed input', async () => {
    expect(await codec.hash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes different tokens differently', async () => {
    expect(await codec.hash('a')).not.toBe(await codec.hash('b'));
  });
});
