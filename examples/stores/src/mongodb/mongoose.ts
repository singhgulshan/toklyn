import {
  MongoAccessTokenRevocationStore,
  MongoSessionStore,
  migrate,
} from '@toklyn/store/mongodb';
import mongoose from 'mongoose';
import { env } from '../example.js';
import type { StoreExample } from '../example.js';

export async function connect(): Promise<StoreExample> {
  await mongoose.connect(env('MONGODB_URL'), { dbName: 'toklyn_example' });
  // Mongoose's connection wraps the official driver's `Db`, which the stores use directly.
  const db = mongoose.connection.db;
  if (!db) throw new Error('Mongoose is not connected');
  await migrate(db);

  return {
    sessions: new MongoSessionStore({ db }),
    revocations: new MongoAccessTokenRevocationStore({ db }),
    close: () => mongoose.disconnect(),
  };
}
