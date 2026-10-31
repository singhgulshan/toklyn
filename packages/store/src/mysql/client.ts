import { malformed } from '#src/mysql/codec.js';

/** A result row keyed by column name. */
export type MySqlRow = Record<string, unknown>;

export interface MySqlResult {
  /** Rows of a `SELECT`; empty for writes. */
  rows: readonly MySqlRow[];
  /** Rows changed by a write; 0 for a `SELECT`. */
  affectedRows: number;
}

/** Runs one parameterized statement (`?` placeholders). */
export interface MySqlExecutor {
  query(sql: string, params: readonly (string | null)[]): Promise<MySqlResult>;
}

/** What the stores need. Wrap your pool with `fromTupleQuery` or `fromDirectQuery`. */
export interface MySqlClient extends MySqlExecutor {
  /** Runs `fn` on one connection inside a transaction: commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: MySqlExecutor) => Promise<T>): Promise<T>;
}

/** Server-side prepared statements via `execute`, cached per connection. Off by default. */
export interface PrepareOptions {
  prepare?: boolean;
}

interface Queryable {
  query(sql: string, values: (string | null)[]): Promise<unknown>;
  execute(sql: string, values: (string | null)[]): Promise<unknown>;
}

export interface QueryConnection extends Queryable {
  release(): unknown;
  destroy(): unknown;
}

export interface QueryPool extends Queryable {
  getConnection(): Promise<QueryConnection>;
}

/** For pools whose `query` and `execute` resolve to `[result, fields]`, e.g. mysql2/promise. */
export function fromTupleQuery(
  pool: QueryPool,
  options: PrepareOptions = {},
): MySqlClient {
  return fromPool(pool, options, (reply) => {
    if (!Array.isArray(reply)) throw malformed();
    return toResult(reply[0]);
  });
}

/** For pools whose `query` and `execute` resolve to the result itself, e.g. mariadb. */
export function fromDirectQuery(
  pool: QueryPool,
  options: PrepareOptions = {},
): MySqlClient {
  return fromPool(pool, options, toResult);
}

function fromPool(
  pool: QueryPool,
  { prepare = false }: PrepareOptions,
  read: (reply: unknown) => MySqlResult,
): MySqlClient {
  const executor = (target: Queryable): MySqlExecutor => ({
    query: async (sql, params) =>
      read(
        await (prepare
          ? target.execute(sql, [...params])
          : target.query(sql, [...params])),
      ),
  });

  return {
    ...executor(pool),
    async transaction<T>(fn: (tx: MySqlExecutor) => Promise<T>): Promise<T> {
      const connection = await pool.getConnection();
      let result: T;
      try {
        await connection.query('START TRANSACTION', []);
        result = await fn(executor(connection));
        await connection.query('COMMIT', []);
      } catch (error) {
        try {
          await connection.query('ROLLBACK', []);
        } catch {
          // Never hand a connection with an open transaction back to the pool.
          connection.destroy();
          throw error;
        }
        await connection.release();
        throw error;
      }
      await connection.release();
      return result;
    },
  };
}

function toResult(reply: unknown): MySqlResult {
  if (Array.isArray(reply)) {
    return { rows: reply as MySqlRow[], affectedRows: 0 };
  }
  if (typeof reply === 'object' && reply !== null) {
    const affected = (reply as { affectedRows?: unknown }).affectedRows;
    if (typeof affected === 'number' || typeof affected === 'bigint') {
      return { rows: [], affectedRows: Number(affected) };
    }
  }
  throw malformed();
}
