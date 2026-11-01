import type { StoreExample } from './example.js';

interface ExampleEntry {
  /** Environment variables the example needs; `--all` skips it when one is missing. */
  needs: readonly string[];
  load(): Promise<{ connect(): Promise<StoreExample> }>;
}

export const examples: Record<string, ExampleEntry> = {
  'postgres/pg': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/pg.js'),
  },
  'postgres/postgres-js': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/postgres-js.js'),
  },
  'postgres/prisma': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/prisma.js'),
  },
  'postgres/drizzle': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/drizzle.js'),
  },
  'postgres/typeorm': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/typeorm.js'),
  },
  'postgres/sequelize': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/sequelize.js'),
  },
  'postgres/knex': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/knex.js'),
  },
  'postgres/kysely': {
    needs: ['POSTGRES_URL'],
    load: () => import('./postgres/kysely.js'),
  },
  'mysql/mysql2': {
    needs: ['MYSQL_URL'],
    load: () => import('./mysql/mysql2.js'),
  },
  'mysql/mariadb': {
    needs: ['MARIADB_URL'],
    load: () => import('./mysql/mariadb.js'),
  },
  'mysql/prisma': {
    needs: ['MYSQL_URL'],
    load: () => import('./mysql/prisma.js'),
  },
  'mysql/drizzle': {
    needs: ['MYSQL_URL'],
    load: () => import('./mysql/drizzle.js'),
  },
  'mysql/typeorm': {
    needs: ['MYSQL_URL'],
    load: () => import('./mysql/typeorm.js'),
  },
  'mysql/sequelize': {
    needs: ['MYSQL_URL'],
    load: () => import('./mysql/sequelize.js'),
  },
  'mysql/knex': {
    needs: ['MYSQL_URL'],
    load: () => import('./mysql/knex.js'),
  },
  'mysql/kysely': {
    needs: ['MYSQL_URL'],
    load: () => import('./mysql/kysely.js'),
  },
  'sqlite/node-sqlite': {
    needs: [],
    load: () => import('./sqlite/node-sqlite.js'),
  },
  'sqlite/better-sqlite3': {
    needs: [],
    load: () => import('./sqlite/better-sqlite3.js'),
  },
  'sqlite/libsql': { needs: [], load: () => import('./sqlite/libsql.js') },
  'sqlite/drizzle': { needs: [], load: () => import('./sqlite/drizzle.js') },
  'sqlite/knex': { needs: [], load: () => import('./sqlite/knex.js') },
  'sqlite/kysely': { needs: [], load: () => import('./sqlite/kysely.js') },
  'mongodb/mongodb': {
    needs: ['MONGODB_URL'],
    load: () => import('./mongodb/mongodb.js'),
  },
  'mongodb/mongoose': {
    needs: ['MONGODB_URL'],
    load: () => import('./mongodb/mongoose.js'),
  },
  'redis/ioredis': {
    needs: ['REDIS_URL'],
    load: () => import('./redis/ioredis.js'),
  },
  'redis/node-redis': {
    needs: ['REDIS_URL'],
    load: () => import('./redis/node-redis.js'),
  },
  'redis/upstash': {
    needs: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    load: () => import('./redis/upstash.js'),
  },
};
