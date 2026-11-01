import {
  MongoAccessTokenRevocationStore,
  MongoSessionStore,
  migrate,
} from '@toklyn/store/mongodb';
import mongoose from 'mongoose';
import { requireEnv } from '../config.js';
import type { Stores } from '../walkthrough.js';

export async function connect(): Promise<Stores> {
  await mongoose.connect(requireEnv('MONGODB_URL'), {
    dbName: 'toklyn_example',
  });
  // Mongoose wraps the official driver's `Db`, which the stores use directly.
  const db = mongoose.connection.db;
  if (!db) throw new Error('Mongoose is not connected');
  await migrate(db);

  return {
    sessions: new MongoSessionStore({ db }),
    revocations: new MongoAccessTokenRevocationStore({ db }),
    close: () => mongoose.disconnect(),
  };
}
