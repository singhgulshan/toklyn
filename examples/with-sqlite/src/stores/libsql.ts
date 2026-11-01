import { createClient } from '@libsql/client';
import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  fromExecuteDatabase,
  migrate,
} from '@toklyn/store/sqlite';
import { sqlitePath } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  // A local file here; for Turso use `libsql://...` with an `authToken`.
  const db = createClient({ url: `file:${sqlitePath()}` });
  const client = fromExecuteDatabase(db);
  await migrate(client);

  return {
    sessions: new SqliteSessionStore({ client }),
    revocations: new SqliteAccessTokenRevocationStore({ client }),
    close: async () => db.close(),
  };
}
