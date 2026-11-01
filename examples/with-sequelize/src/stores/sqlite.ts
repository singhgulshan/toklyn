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
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import {
  sqlitePath,
  toNumberedPlaceholders,
  withDriverError,
} from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: sqlitePath(),
    logging: false,
    // Each Sequelize transaction opens its own connection, so writers can find the database
    // locked; retry instead of failing at once.
    retry: { match: [/SQLITE_BUSY/], max: 20 },
  });

  const executor = (transaction?: Transaction): SqliteExecutor => ({
    async all(sql, params) {
      try {
        const [rows] = await sequelize.query(toNumberedPlaceholders(sql), {
          bind: [...params],
          type: QueryTypes.RAW,
          transaction,
        });
        return rows as SqliteRow[];
      } catch (error) {
        throw withDriverError(error);
      }
    },
    async run(sql, params) {
      try {
        // BULKUPDATE makes Sequelize use SQLite's run() and return the changed-row count.
        const changes: unknown = await sequelize.query(
          toNumberedPlaceholders(sql),
          { bind: [...params], type: QueryTypes.BULKUPDATE, transaction },
        );
        return Number(changes);
      } catch (error) {
        throw withDriverError(error);
      }
    },
  });
  // Rotation runs inside an IMMEDIATE transaction, which takes the write lock up front.
  const client: SqliteClient = {
    ...executor(),
    transaction: (fn) =>
      sequelize
        .transaction({ type: Transaction.TYPES.IMMEDIATE }, (t) =>
          fn(executor(t)),
        )
        .catch((error: unknown) => {
          throw withDriverError(error);
        }),
  };
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: () => sequelize.close(),
  };
}
