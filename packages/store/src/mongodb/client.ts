/** A MongoDB document. */
export type MongoDocument = Record<string, unknown>;

export interface MongoCursor {
  toArray(): Promise<MongoDocument[]>;
}

/** The collection methods the stores use; the official driver's `Collection` (v6+) fits. */
export interface MongoCollection {
  findOne(
    filter: MongoDocument,
    options?: { projection?: MongoDocument },
  ): Promise<MongoDocument | null>;
  find(
    filter: MongoDocument,
    options?: { projection?: MongoDocument; sort?: MongoDocument },
  ): MongoCursor;
  insertOne(document: MongoDocument): Promise<unknown>;
  updateOne(
    filter: MongoDocument,
    update: MongoDocument,
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }>;
  findOneAndUpdate(
    filter: MongoDocument,
    update: MongoDocument,
    options: { returnDocument: 'after'; projection?: MongoDocument },
  ): Promise<MongoDocument | null>;
  deleteMany(filter: MongoDocument): Promise<{ deletedCount: number }>;
  createIndex(
    keys: Record<string, 1>,
    options?: { name?: string; unique?: boolean; expireAfterSeconds?: number },
  ): Promise<string>;
}

/** A database handle: the official driver's `Db`, or `mongoose.connection.db`. */
export interface MongoDatabase {
  collection(name: string): MongoCollection;
}
