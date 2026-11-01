import { createClient } from '@libsql/client';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll } from 'vitest';
import { fromExecuteDatabase, fromSyncDatabase } from '#src/sqlite/index.js';
import type { SqliteClient } from '#src/sqlite/index.js';
import { driver } from './suites.js';
import type { Driver } from './suites.js';

/** Node drivers on temporary files or memory, all removed after the test file. */
export function useDrivers() {
  const dir = mkdtempSync(join(tmpdir(), 'toklyn-sqlite-'));
  const closers: (() => void)[] = [];
  let files = 0;
  const freshPath = () => join(dir, `db-${(files += 1)}.sqlite`);

  afterAll(() => {
    for (const close of closers) close();
    rmSync(dir, { recursive: true, force: true });
  });

  const nodeSqlite = (path: string): SqliteClient => {
    const db = new DatabaseSync(path);
    closers.push(() => db.close());
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    return fromSyncDatabase(db);
  };

  const betterSqlite = (path: string): SqliteClient => {
    // timeout 0: a busy lock must reach the store's retry, not block the event loop.
    const db = new Database(path, { timeout: 0 });
    closers.push(() => db.close());
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
    return fromSyncDatabase(db);
  };

  const libsql = async (path: string): Promise<SqliteClient> => {
    const db = createClient({ url: `file:${path}` });
    closers.push(() => db.close());
    await db.execute('PRAGMA journal_mode = WAL');
    return fromExecuteDatabase(db);
  };

  return {
    nodeMemory: driver(() => nodeSqlite(':memory:')),
    nodeFile: driver(freshPath, nodeSqlite),
    betterMemory: driver(() => betterSqlite(':memory:')),
    betterFile: driver(freshPath, betterSqlite),
    // One client per database: a libSQL connection whose BEGIN IMMEDIATE failed keeps its lock
    // until garbage collection, so two clients racing on one file in one process get stuck.
    libsqlFile: { fresh: driver(freshPath, libsql).fresh },
  } satisfies Record<string, Driver>;
}
