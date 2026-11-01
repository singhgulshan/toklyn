import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromSyncDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const sqlite = new Database(process.env.SQLITE_PATH ?? 'toklyn-example.db');
  sqlite.pragma('journal_mode = WAL');
  // Your app queries through Drizzle; toklyn shares the same connection.
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
