import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromSyncDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import { DatabaseSync } from 'node:sqlite';
import { sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const db = new DatabaseSync(sqlitePath());
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  const client = fromSyncDatabase(db);
  // Creates toklyn's tables if missing.
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: async () => db.close(),
  };
}
