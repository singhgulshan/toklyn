import { Database } from 'bun:sqlite';
import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromSyncDatabase } from '#src/sqlite/index.js';
import type { SqliteClient } from '#src/sqlite/index.js';
import { driver, sqliteSuites } from '../sqlite/suites.js';

// Run with `bun test` (pnpm test:bun); vitest skips this folder.
const dir = mkdtempSync(join(tmpdir(), 'toklyn-bun-sqlite-'));
const databases: Database[] = [];
let files = 0;

afterAll(() => {
  for (const db of databases) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(path: string): SqliteClient {
  const db = new Database(path);
  databases.push(db);
  if (path !== ':memory:') db.run('PRAGMA journal_mode = WAL');
  return fromSyncDatabase(db);
}

sqliteSuites(
  'bun:sqlite, memory',
  driver(() => open(':memory:')),
);
sqliteSuites(
  'bun:sqlite, file',
  driver(() => join(dir, `db-${(files += 1)}.sqlite`), open),
);
