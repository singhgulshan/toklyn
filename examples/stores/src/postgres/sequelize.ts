import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import { QueryTypes, Sequelize } from 'sequelize';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const sequelize = new Sequelize(env('POSTGRES_URL'), {
    dialect: 'postgres',
    logging: false,
  });

  const client: PostgresClient = {
    async query(text, params) {
      // `bind` sends the values as real parameters ($1, $2, ...), not inlined into the SQL.
      const [rows] = await sequelize.query(text, {
        bind: [...params],
        type: QueryTypes.RAW,
      });
      return rows as PostgresRow[];
    },
  };
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => sequelize.close(),
  };
}
