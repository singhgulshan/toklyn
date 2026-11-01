import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromSyncDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import Database from 'better-sqlite3';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const db = new Database(process.env.SQLITE_PATH ?? 'toklyn-example.db');
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
