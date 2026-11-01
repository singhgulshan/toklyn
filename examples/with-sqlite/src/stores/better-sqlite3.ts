import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromSyncDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import Database from 'better-sqlite3';
import { sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const db = new Database(sqlitePath());
  db.pragma('journal_mode = WAL');
  const client = fromSyncDatabase(db);
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: async () => {
      db.close();
    },
  };
}
