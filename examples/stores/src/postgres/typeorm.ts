import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  migrate,
} from '@toklyn/store/postgres';
import type { PostgresClient, PostgresRow } from '@toklyn/store/postgres';
import { DataSource } from 'typeorm';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: env('POSTGRES_URL'),
  });
  await dataSource.initialize();

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
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => dataSource.destroy(),
  };
}
