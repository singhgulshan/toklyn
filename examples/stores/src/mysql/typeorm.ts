import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor } from '@toklyn/store/mysql';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { env, toMySqlResult, withDriverErrno } from '../example.js';
import type { StoreExample } from '../example.js';

function executor(runner: QueryRunner): MySqlExecutor {
  return {
    async query(sql, params) {
      try {
        const result = await runner.query(sql, [...params], true);
        return toMySqlResult(result.records ?? result.raw);
      } catch (error) {
        throw withDriverErrno(error);
      }
    },
  };
}

export async function connect(): Promise<StoreExample> {
  const dataSource = new DataSource({ type: 'mysql', url: env('MYSQL_URL') });
  await dataSource.initialize();

  const client: MySqlClient = {
    async query(sql, params) {
      const runner = dataSource.createQueryRunner();
      try {
        return await executor(runner).query(sql, params);
      } finally {
        await runner.release();
      }
    },
    transaction: (fn) =>
      dataSource.transaction((manager) =>
        fn(executor(manager.queryRunner as QueryRunner)),
      ),
  };
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => dataSource.destroy(),
  };
}
