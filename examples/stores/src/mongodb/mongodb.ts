import {
  MongoAccessTokenRevocationStore,
  MongoSessionStore,
  migrate,
} from '@toklyn/store/mongodb';
import { MongoClient } from 'mongodb';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  const mongo = new MongoClient(env('MONGODB_URL'));
  await mongo.connect();
  const db = mongo.db('toklyn_example');
  await migrate(db);

  return {
    sessions: new MongoSessionStore({ db }),
    revocations: new MongoAccessTokenRevocationStore({ db }),
    close: () => mongo.close(),
  };
}
