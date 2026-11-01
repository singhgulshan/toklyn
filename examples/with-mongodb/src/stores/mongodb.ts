import {
  MongoAccessTokenRevocationStore,
  MongoSessionStore,
  migrate,
} from '@toklyn/store/mongodb';
import { MongoClient } from 'mongodb';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  const mongo = new MongoClient(requireEnv('MONGODB_URL'));
  await mongo.connect();
  const db = mongo.db('toklyn_example');
  // Creates toklyn's indexes, including the TTL index that deletes expired sessions.
  await migrate(db);

  return {
    sessions: new MongoSessionStore({ db }),
    revocations: new MongoAccessTokenRevocationStore({ db }),
    close: () => mongo.close(),
  };
}
