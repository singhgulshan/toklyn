import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  migrate,
} from '@toklyn/store/sqlite';
import type {
  SqliteClient,
  SqliteExecutor,
  SqliteRow,
} from '@toklyn/store/sqlite';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { serialized, sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';

function executor(runner: QueryRunner): SqliteExecutor {
  return {
    async all(sql, params) {
      const result = await runner.query(sql, [...params], true);
      return result.records as SqliteRow[];
    },
    async run(sql, params) {
      const result = await runner.query(sql, [...params], true);
      return result.affected ?? 0;
    },
  };
}

export async function connect(): Promise<Stores> {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: sqlitePath(),
  });
  await dataSource.initialize();

  const withRunner = async <T>(task: (tx: SqliteExecutor) => Promise<T>) => {
    const runner = dataSource.createQueryRunner();
    try {
      return await task(executor(runner));
    } finally {
      await runner.release();
    }
  };
  // TypeORM's SQLite driver shares one connection, so calls must not overlap a transaction.
  const serialize = serialized();
  const client: SqliteClient = {
    all: (sql, params) =>
      serialize(() => withRunner((tx) => tx.all(sql, params))),
    run: (sql, params) =>
      serialize(() => withRunner((tx) => tx.run(sql, params))),
    transaction: (fn) =>
      serialize(() =>
        dataSource.transaction((manager) =>
          fn(executor(manager.queryRunner as QueryRunner)),
        ),
      ),
  };
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: () => dataSource.destroy(),
  };
}
