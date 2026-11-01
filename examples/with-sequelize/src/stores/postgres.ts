import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import { QueryTypes, Sequelize } from 'sequelize';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const sequelize = new Sequelize(requireEnv('POSTGRES_URL'), {
    dialect: 'postgres',
    logging: false,
  });

  // toklyn's SQL runs as raw queries on Sequelize's pool. `bind` sends the values as real
  // parameters ($1, $2, ...), never inlined into the SQL.
  const client: PostgresClient = {
    async query(text, params) {
      const [rows] = await sequelize.query(text, {
        bind: [...params],
        type: QueryTypes.RAW,
      });
      return rows as PostgresRow[];
    },
  };
  // Creates toklyn's tables if missing. In production, run it from a deploy step.
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => sequelize.close(),
  };
}
