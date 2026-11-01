import { PrismaPg } from '@prisma/adapter-pg';
import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromVariadicQuery,
  migrate,
} from '@toklyn/store/postgres';
import { PrismaClient } from '../../generated/prisma-postgres/client.ts';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env('POSTGRES_URL') }),
  });
  // toklyn runs its own SQL through `$queryRawUnsafe`, always with bound parameters.
  const client = fromVariadicQuery(prisma);
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => prisma.$disconnect(),
  };
}
