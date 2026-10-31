import { describe, expect, it, vi } from 'vitest';
import {
  fromArrayEval,
  fromOptionsEval,
  fromVariadicEval,
} from '#src/redis/index.js';

const keys = ['k1', 'k2'];
const args = ['a1'];

describe('client adapters', () => {
  it('passes the key count and flattened arguments to ioredis', async () => {
    const evalFn = vi.fn(async () => 'ok');

    await fromVariadicEval({ eval: evalFn }).eval('script', keys, args);

    expect(evalFn).toHaveBeenCalledWith('script', 2, 'k1', 'k2', 'a1');
  });

  it('passes keys and arguments as options to node-redis', async () => {
    const evalFn = vi.fn(async () => 'ok');

    await fromOptionsEval({ eval: evalFn }).eval('script', keys, args);

    expect(evalFn).toHaveBeenCalledWith('script', {
      keys: ['k1', 'k2'],
      arguments: ['a1'],
    });
  });

  it('passes keys and arguments as arrays to Upstash', async () => {
    const evalFn = vi.fn(async () => 'ok');

    const reply = await fromArrayEval({ eval: evalFn }).eval(
      'script',
      keys,
      args,
    );

    expect(evalFn).toHaveBeenCalledWith('script', ['k1', 'k2'], ['a1']);
    expect(reply).toBe('ok');
  });
});
