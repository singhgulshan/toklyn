import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor } from '@toklyn/store/mysql';
import { QueryTypes, Sequelize } from 'sequelize';
import type { Transaction } from 'sequelize';
import {
  env,
  toMySqlResult,
  toNumberedPlaceholders,
  withDriverErrno,
} from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const sequelize = new Sequelize(env('MYSQL_URL'), {
    dialect: 'mysql',
    logging: false,
  });

  const executor = (transaction?: Transaction): MySqlExecutor => ({
    async query(sql, params) {
      try {
        // `bind` sends the values as real parameters, not inlined into the SQL.
        const [result] = await sequelize.query(toNumberedPlaceholders(sql), {
          bind: [...params],
          type: QueryTypes.RAW,
          transaction,
        });
        return toMySqlResult(result);
      } catch (error) {
        throw withDriverErrno(error);
      }
    },
  });
  const client: MySqlClient = {
    ...executor(),
    transaction: (fn) => sequelize.transaction((t) => fn(executor(t))),
  };
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => sequelize.close(),
  };
}
