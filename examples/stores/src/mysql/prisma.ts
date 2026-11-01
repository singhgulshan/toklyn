import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
  migrate,
} from '@toklyn/store/mysql';
import type { MySqlClient, MySqlExecutor, MySqlRow } from '@toklyn/store/mysql';
import { PrismaClient } from '../../generated/prisma-mysql/client.ts';
import { env, mysqlOptions } from '../example.js';
import type { StoreExample } from '../example.js';

type RawQueries = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

// Prisma reports deadlocks as P2034; the store retries errors with MySQL's errno 1213.
const DEADLOCK = 1213;

function executor(db: RawQueries): MySqlExecutor {
  return {
    async query(sql, params) {
      try {
        // Reads go through $queryRaw; writes through $executeRaw, which returns the changed rows.
        if (/^\s*select\b/i.test(sql)) {
          const rows = await db.$queryRawUnsafe<MySqlRow[]>(sql, ...params);
          return { rows, affectedRows: 0 };
        }
        const affectedRows = await db.$executeRawUnsafe(sql, ...params);
        return { rows: [], affectedRows };
      } catch (error) {
        if ((error as { code?: unknown }).code === 'P2034') {
          throw Object.assign(error as Error, { errno: DEADLOCK });
        }
        throw error;
      }
    },
  };
}

export async function connect(): Promise<StoreExample> {
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb(mysqlOptions(env('MYSQL_URL'))),
  });

  const client: MySqlClient = {
    ...executor(prisma),
    transaction: (fn) => prisma.$transaction((tx) => fn(executor(tx))),
  };
  await migrate(client);

  return {
    sessions: new MySqlSessionStore({ client }),
    revocations: new MySqlAccessTokenRevocationStore({ client }),
    close: () => prisma.$disconnect(),
  };
}
