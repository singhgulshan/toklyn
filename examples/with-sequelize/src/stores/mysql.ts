import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor } from '@toklyn/store/mysql';
import { QueryTypes, Sequelize } from 'sequelize';
import type { Transaction } from 'sequelize';
import {
  requireEnv,
  toMySqlResult,
  toNumberedPlaceholders,
  withDriverError,
} from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const sequelize = new Sequelize(requireEnv('MYSQL_URL'), {
    dialect: 'mysql',
    logging: false,
  });

  const executor = (transaction?: Transaction): MySqlExecutor => ({
    async query(sql, params) {
      try {
        // `bind` sends the values as real parameters, never inlined into the SQL.
        const [result] = await sequelize.query(toNumberedPlaceholders(sql), {
          bind: [...params],
          type: QueryTypes.RAW,
          transaction,
        });
        return toMySqlResult(result);
      } catch (error) {
        throw withDriverError(error);
      }
    },
  });
  // Rotation runs inside a Sequelize transaction, on one connection.
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
