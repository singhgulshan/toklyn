import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromSyncDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import { DatabaseSync } from 'node:sqlite';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const db = new DatabaseSync(process.env.SQLITE_PATH ?? 'toklyn-example.db');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
  const client = fromSyncDatabase(db);
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: async () => db.close(),
  };
}
