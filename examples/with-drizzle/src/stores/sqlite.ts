import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromSyncDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const sqlite = new Database(sqlitePath());
  sqlite.pragma('journal_mode = WAL');
  // Your app queries through Drizzle; toklyn shares the connection Drizzle runs on.
  const db = drizzle({ client: sqlite });
  const client = fromSyncDatabase(db.$client);
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: async () => {
      sqlite.close();
    },
  };
}
