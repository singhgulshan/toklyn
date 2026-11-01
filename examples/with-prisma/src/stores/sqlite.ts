import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
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
import { PrismaClient } from '../../generated/sqlite/client.ts';
import { sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';

type RawQueries = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

// Reads go through $queryRaw; writes through $executeRaw, which returns the changed rows.
function executor(db: RawQueries): SqliteExecutor {
  return {
    all: (sql, params) => db.$queryRawUnsafe<SqliteRow[]>(sql, ...params),
    run: (sql, params) => db.$executeRawUnsafe(sql, ...params),
  };
}

export async function connect(): Promise<Stores> {
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${sqlitePath()}` }),
  });

  // Rotation runs inside a Prisma interactive transaction.
  const client: SqliteClient = {
    ...executor(prisma),
    transaction: (fn) => prisma.$transaction((tx) => fn(executor(tx))),
  };
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: () => prisma.$disconnect(),
  };
}
