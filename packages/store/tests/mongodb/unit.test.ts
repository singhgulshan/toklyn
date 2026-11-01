import { ToklynError } from 'toklyn';
import { describe, expect, it } from 'vitest';
import {
  MongoAccessTokenRevocationStore,
  MongoSessionStore,
  migrate,
} from '#src/mongodb/index.js';
import type { MongoCollection, MongoDatabase } from '#src/mongodb/index.js';

function fakeDb() {
  const names: string[] = [];
  const indexes: string[] = [];
  const db: MongoDatabase = {
    collection(name) {
      names.push(name);
      return {
        createIndex: async (keys, options) => {
          indexes.push(
            `${name} ${JSON.stringify(keys)} ${JSON.stringify(options)}`,
          );
          return options?.name ?? '';
        },
      } as Partial<MongoCollection> as MongoCollection;
    },
  };
  return { db, names, indexes };
}

describe('MongoDB options', () => {
  it.each(['Toklyn_', '1abc', 'a-b', 'a.b', 'x'.repeat(25)])(
    'rejects collectionPrefix %j',
    (collectionPrefix) => {
      const { db } = fakeDb();

      expect(() => new MongoSessionStore({ db, collectionPrefix })).toThrow(
        ToklynError,
      );
      expect(
        () => new MongoAccessTokenRevocationStore({ db, collectionPrefix }),
      ).toThrow(expect.objectContaining({ code: 'invalid_config' }));
    },
  );

  it('prefixes collections and accepts an empty prefix', () => {
    const { db, names } = fakeDb();

    new MongoSessionStore({ db, collectionPrefix: 'app_' });
    new MongoSessionStore({ db, collectionPrefix: '' });

    expect(names).toEqual([
      'app_sessions',
      'app_access_token_revocations',
      'sessions',
      'access_token_revocations',
    ]);
  });

  it('creates the unique hash index and TTL indexes', async () => {
    const { db, indexes } = fakeDb();

    await migrate(db);

    expect(indexes).toEqual([
      'toklyn_sessions {"tokens.hash":1} {"name":"tokens_hash","unique":true}',
      'toklyn_sessions {"subject":1} {"name":"subject"}',
      'toklyn_sessions {"expireAt":1} {"name":"expire_at","expireAfterSeconds":0}',
      'toklyn_access_token_revocations {"expireAt":1} {"name":"expire_at","expireAfterSeconds":0}',
    ]);
  });
});
