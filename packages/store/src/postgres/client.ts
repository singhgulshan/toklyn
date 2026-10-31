import { malformed } from '#src/postgres/codec.js';

/** A result row keyed by column name. */
export type PostgresRow = Record<string, unknown>;

/** The one call the stores need. Wrap your client with an adapter below. */
export interface PostgresClient {
  /** Runs one parameterized statement (`$1`, `$2`, ...) and returns its rows. */
  query(
    text: string,
    params: readonly (string | null)[],
  ): Promise<readonly PostgresRow[]>;
}

/** `query(text, params)` resolving to `{ rows }`, e.g. node-postgres `Pool`, PGlite or the Neon serverless `Pool`. */
export interface ResultQueryClient {
  query(
    text: string,
    params: (string | null)[],
  ): Promise<{ rows: readonly unknown[] }>;
}

/** `unsafe(text, params, options)` resolving to the rows, e.g. postgres.js. */
export interface UnsafeQueryClient {
  unsafe(
    text: string,
    params: (string | null)[],
    options?: { prepare?: boolean },
  ): PromiseLike<unknown>;
}

/** `query({ name, text, values })`, a named prepared statement, e.g. node-postgres. */
export interface NamedQueryClient {
  query(config: {
    name: string;
    text: string;
    values: (string | null)[];
  }): Promise<{ rows: readonly unknown[] }>;
}

/**
 * Prepared statements skip query planning on repeat calls, which makes rotation about three
 * times faster. Leave off behind transaction-mode poolers (PgBouncer before 1.21, Supabase
 * port 6543), which may route the next call to a connection that never prepared it.
 */
export interface PrepareOptions {
  prepare?: boolean;
}

/** `$queryRawUnsafe(text, ...params)` resolving to the rows, e.g. Prisma. */
export interface VariadicQueryClient {
  $queryRawUnsafe(text: string, ...params: (string | null)[]): Promise<unknown>;
}

export function fromResultQuery(client: ResultQueryClient): PostgresClient;
/** `prepare` needs the named form of `query`, which node-postgres has and PGlite does not. */
export function fromResultQuery(
  client: ResultQueryClient & NamedQueryClient,
  options: PrepareOptions,
): PostgresClient;
export function fromResultQuery(
  client: ResultQueryClient,
  { prepare = false }: PrepareOptions = {},
): PostgresClient {
  if (!prepare) {
    return {
      query: async (text, params) =>
        rowsOf((await client.query(text, [...params])).rows),
    };
  }
  const named = client as unknown as NamedQueryClient;
  return {
    query: async (text, params) =>
      rowsOf(
        (
          await named.query({
            name: statementName(text),
            text,
            values: [...params],
          })
        ).rows,
      ),
  };
}

export function fromUnsafeQuery(
  client: UnsafeQueryClient,
  { prepare = false }: PrepareOptions = {},
): PostgresClient {
  return {
    query: async (text, params) =>
      rowsOf(
        await (prepare
          ? client.unsafe(text, [...params], { prepare: true })
          : client.unsafe(text, [...params])),
      ),
  };
}

export function fromVariadicQuery(client: VariadicQueryClient): PostgresClient {
  return {
    query: async (text, params) =>
      rowsOf(await client.$queryRawUnsafe(text, ...params)),
  };
}

function rowsOf(rows: unknown): PostgresRow[] {
  if (!Array.isArray(rows)) throw malformed();
  return rows as PostgresRow[];
}

const statementNames = new Map<string, string>();

/** Same text, same name, so each connection prepares a statement once. */
function statementName(text: string): string {
  let name = statementNames.get(text);
  if (name === undefined) {
    name = `toklyn_${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x01000193)}`;
    statementNames.set(text, name);
  }
  return name;
}

function fnv1a(text: string, seed: number): string {
  let hash = seed;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
