import { malformed } from '#src/sqlite/codec.js';

/** A result row keyed by column name. */
export type SqliteRow = Record<string, unknown>;

export type SqliteParam = string | null;

/** Runs one parameterized statement (`?` placeholders). */
export interface SqliteExecutor {
  /** For statements that return rows: `SELECT` or `... RETURNING`. */
  all(sql: string, params: readonly SqliteParam[]): Promise<SqliteRow[]>;
  /** For writes. Resolves to the number of rows changed. */
  run(sql: string, params: readonly SqliteParam[]): Promise<number>;
}

/** What the stores need. Wrap your database with `fromSyncDatabase` or `fromExecuteDatabase`. */
export interface SqliteClient extends SqliteExecutor {
  /** Runs `fn` inside `BEGIN IMMEDIATE`: commits if it resolves, rolls back if it throws. */
  transaction<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
}

export interface SyncStatement {
  all(...params: SqliteParam[]): unknown[];
  run(...params: SqliteParam[]): { changes: number | bigint };
}

export interface SyncDatabase {
  prepare(sql: string): SyncStatement;
}

const MAX_CACHED_STATEMENTS = 64;

/**
 * For synchronous databases with `prepare(sql).all()/.run()`, e.g. `node:sqlite`, better-sqlite3
 * and `bun:sqlite`. Calls on one database run one at a time, so a transaction never interleaves
 * with other work on the same connection. Inside `transaction`, use only the `tx` it passes.
 */
export function fromSyncDatabase(db: SyncDatabase): SqliteClient {
  const statements = new Map<string, SyncStatement>();
  const prepare = (sql: string): SyncStatement => {
    let statement = statements.get(sql);
    if (!statement) {
      if (statements.size >= MAX_CACHED_STATEMENTS) {
        statements.delete(statements.keys().next().value as string);
      }
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  const direct: SqliteExecutor = {
    all: async (sql, params) => toRows(prepare(sql).all(...params)),
    run: async (sql, params) => toChanges(prepare(sql).run(...params).changes),
  };
  const serialize = createQueue();

  return {
    all: (sql, params) => serialize(() => direct.all(sql, params)),
    run: (sql, params) => serialize(() => direct.run(sql, params)),
    transaction: (fn) =>
      serialize(async () => {
        await direct.run('BEGIN IMMEDIATE', []);
        try {
          const result = await fn(direct);
          await direct.run('COMMIT', []);
          return result;
        } catch (error) {
          await direct.run('ROLLBACK', []).catch(rolledBackAlready);
          throw error;
        }
      }),
  };
}

export interface ExecuteStatement {
  sql: string;
  args: SqliteParam[];
}

export interface ExecuteResult {
  rows: ArrayLike<unknown>;
  rowsAffected: number | bigint;
}

export interface ExecuteTarget {
  execute(statement: ExecuteStatement): Promise<ExecuteResult>;
}

export interface ExecuteTransaction extends ExecuteTarget {
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  close(): unknown;
}

export interface ExecuteDatabase extends ExecuteTarget {
  transaction(mode: 'write'): Promise<ExecuteTransaction>;
}

/** For async clients with `execute({ sql, args })` and `transaction('write')`, e.g. libSQL/Turso. */
export function fromExecuteDatabase(db: ExecuteDatabase): SqliteClient {
  const executor = (target: ExecuteTarget): SqliteExecutor => ({
    all: async (sql, args) =>
      toRows(Array.from((await target.execute({ sql, args: [...args] })).rows)),
    run: async (sql, args) =>
      toChanges((await target.execute({ sql, args: [...args] })).rowsAffected),
  });

  return {
    ...executor(db),
    async transaction<T>(fn: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
      const tx = await db.transaction('write');
      try {
        const result = await fn(executor(tx));
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback().catch(rolledBackAlready);
        throw error;
      } finally {
        tx.close();
      }
    },
  };
}

// SQLite rolls back by itself after some errors; ROLLBACK then fails with nothing left to undo.
function rolledBackAlready(): void {}

function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

function toRows(rows: unknown): SqliteRow[] {
  if (
    !Array.isArray(rows) ||
    !rows.every((row) => typeof row === 'object' && row !== null)
  ) {
    throw malformed();
  }
  return rows as SqliteRow[];
}

function toChanges(changes: unknown): number {
  if (typeof changes === 'number' || typeof changes === 'bigint') {
    return Number(changes);
  }
  throw malformed();
}
