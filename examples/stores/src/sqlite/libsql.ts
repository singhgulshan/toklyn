import { createClient } from '@libsql/client';
import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromExecuteDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  // A local file here; for Turso use `libsql://...` with an `authToken`.
  const db = createClient({
    url: `file:${process.env.SQLITE_PATH ?? 'toklyn-example.db'}`,
  });
  const client = fromExecuteDatabase(db);
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: async () => db.close(),
  };
}
