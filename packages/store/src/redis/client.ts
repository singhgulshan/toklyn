/** The one command the stores need. Wrap your client with an adapter below. */
export interface RedisClient {
  eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown>;
}

/** `eval(script, numKeys, ...keysAndArgs)`, e.g. ioredis. */
export interface VariadicEvalClient {
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: string[]
  ): Promise<unknown>;
}

/** `eval(script, { keys, arguments })`, e.g. node-redis. */
export interface OptionsEvalClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

/**
 * `eval(script, keys, args)`, e.g. Upstash. Create the Upstash client with
 * `automaticDeserialization: false` so replies stay strings.
 */
export interface ArrayEvalClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export function fromVariadicEval(client: VariadicEvalClient): RedisClient {
  return {
    eval: (script, keys, args) =>
      client.eval(script, keys.length, ...keys, ...args),
  };
}

export function fromOptionsEval(client: OptionsEvalClient): RedisClient {
  return {
    eval: (script, keys, args) =>
      client.eval(script, { keys: [...keys], arguments: [...args] }),
  };
}

export function fromArrayEval(client: ArrayEvalClient): RedisClient {
  return {
    eval: (script, keys, args) => client.eval(script, [...keys], [...args]),
  };
}
