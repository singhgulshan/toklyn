import { PrismaPg } from '@prisma/adapter-pg';
import {
  PostgresAccessTokenRevocationStore,
  PostgresSessionStore,
  fromVariadicQuery,
  migrate,
} from '@toklyn/store/postgres';
import { PrismaClient } from '../../generated/postgres/client.ts';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireEnv('POSTGRES_URL') }),
  });
  // toklyn's SQL runs through `$queryRawUnsafe`, always with bound parameters.
  const client = fromVariadicQuery(prisma);
  // Creates toklyn's tables if missing. In production, run it from a deploy step.
  await migrate(client);

  return {
    sessions: new PostgresSessionStore({ client }),
    revocations: new PostgresAccessTokenRevocationStore({ client }),
    close: () => prisma.$disconnect(),
  };
}
