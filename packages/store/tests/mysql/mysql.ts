import * as mariadb from 'mariadb';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import type { AccessTokenRevocationStore } from 'toklyn';
import { afterAll } from 'vitest';
import { fromDirectQuery, fromTupleQuery, migrate } from '#src/mysql/index.js';
import type { MySqlClient } from '#src/mysql/index.js';

/** Set to run the suites against real servers, e.g. mysql://root:root@127.0.0.1:3306. */
export const MYSQL_URL = process.env.MYSQL_URL;
export const MARIADB_URL = process.env.MARIADB_URL;

export interface TestDatabase {
  client: MySqlClient;
  database: string;
  /** A new, migrated table prefix, so every store starts empty. */
  freshPrefix(): Promise<string>;
}

/** mysql2 and mariadb pools against one server, sharing a throwaway database dropped afterwards. */
export function useServer(url: string) {
  const { hostname, port, username, password } = new URL(url);
  const connection = {
    host: hostname,
    port: Number(port || 3306),
    user: decodeURIComponent(username),
    password: decodeURIComponent(password),
    connectionLimit: 4,
  };
  const tuplePool = mysql.createPool(connection);
  const directPool = mariadb.createPool({
    ...connection,
    // MySQL 8 caching_sha2_password over plain TCP in CI.
    allowPublicKeyRetrieval: true,
  });
  const database = `toklyn_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = fromTupleQuery(tuplePool);
  const ready = admin.query(`CREATE DATABASE \`${database}\``, []);
  let prefixes = 0;

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``, []);
    await Promise.all([tuplePool.end(), directPool.end()]);
  });

  const db = (client: MySqlClient): TestDatabase => ({
    client,
    database,
    async freshPrefix() {
      await ready;
      prefixes += 1;
      const tablePrefix = `t${prefixes}_`;
      await migrate(admin, { database, tablePrefix });
      return tablePrefix;
    },
  });
  return {
    tuple: db(fromTupleQuery(tuplePool)),
    tuplePrepared: db(fromTupleQuery(tuplePool, { prepare: true })),
    direct: db(fromDirectQuery(directPool)),
    directPrepared: db(fromDirectQuery(directPool, { prepare: true })),
  };
}

/** The revocation contract wants a synchronous factory; this waits for the tables lazily. */
export function lazyRevocationStore(
  create: () => Promise<AccessTokenRevocationStore>,
): AccessTokenRevocationStore {
  const ready = create();
  return {
    revoke: async (jti, expiresAt) => (await ready).revoke(jti, expiresAt),
    isRevoked: async (jti) => (await ready).isRevoked(jti),
  };
}
