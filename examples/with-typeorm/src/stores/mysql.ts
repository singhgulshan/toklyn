import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor } from '@toklyn/store/mysql';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import { requireEnv, toMySqlResult, withDriverErrno } from '../config.js';
import type { Stores } from '../walkthrough.js';

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

export async function connect(): Promise<Stores> {
  const dataSource = new DataSource({
    type: 'mysql',
    url: requireEnv('MYSQL_URL'),
  });
  await dataSource.initialize();

  // Rotation runs inside a TypeORM transaction, on one connection.
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
