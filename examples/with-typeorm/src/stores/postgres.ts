import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import { DataSource } from 'typeorm';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: requireEnv('POSTGRES_URL'),
  });
  await dataSource.initialize();

  // toklyn's SQL runs as raw, parameterized queries on TypeORM's pool.
  const client: PostgresClient = {
    async query(text, params) {
      const runner = dataSource.createQueryRunner();
      try {
        // The structured result has the rows for every statement, including UPDATE ... RETURNING.
        const result = await runner.query(text, [...params], true);
        return result.records as PostgresRow[];
      } finally {
        await runner.release();
      }
    },
  };
  // Creates toklyn's tables if missing. In production, run it from a deploy step.
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => dataSource.destroy(),
  };
}
