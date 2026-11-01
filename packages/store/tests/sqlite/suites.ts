import type { AccessTokenRevocationStore, NewSession, Session } from 'toklyn';
import { revocationStoreContract, sessionStoreContract } from 'toklyn/testing';
import { describe, expect, it } from 'vitest';
import {
  SqliteAccessTokenRevocationStore,
  SqliteSessionStore,
  migrate,
} from '#src/sqlite/index.js';
import type { SqliteClient } from '#src/sqlite/index.js';

// Shared by the Node (vitest) and Bun (`bun test`) runs; Bun maps `vitest` imports to `bun:test`.

export interface Driver {
  /** A new, migrated, empty database. */
  fresh(): Promise<SqliteClient>;
  /** Two connections to one new, migrated database file. */
  pair?(): Promise<[SqliteClient, SqliteClient]>;
}

type Open = (path: string) => SqliteClient | Promise<SqliteClient>;

export function driver(open: () => SqliteClient): Driver;
export function driver(freshPath: () => string, open: Open): Driver;
export function driver(
  first: () => SqliteClient | string,
  open?: Open,
): Driver {
  if (!open) return { fresh: () => migrated(first() as SqliteClient) };
  const freshPath = first as () => string;
  return {
    fresh: async () => migrated(await open(freshPath())),
    async pair() {
      const path = freshPath();
      return [await migrated(await open(path)), await open(path)];
    },
  };
}

async function migrated(client: SqliteClient): Promise<SqliteClient> {
  await migrate(client);
  return client;
}

/** The revocation contract wants a synchronous factory; this waits for the tables lazily. */
function lazyRevocationStore(
  create: () => Promise<AccessTokenRevocationStore>,
): AccessTokenRevocationStore {
  const ready = create();
  return {
    revoke: async (jti, expiresAt) => (await ready).revoke(jti, expiresAt),
    isRevoked: async (jti) => (await ready).isRevoked(jti),
  };
}

const T0 = 1_700_000_000_123;
const HOUR = 3_600_000;

function newSession(overrides: Partial<Session> = {}): NewSession {
  const session: Session = {
    id: 'session-1',
    subject: 'user-1',
    claims: { role: 'admin' },
    metadata: {},
    createdAt: T0,
    lastRefreshedAt: T0,
    expiresAt: T0 + 2 * HOUR,
    revokedAt: null,
    ...overrides,
  };
  return {
    session,
    refreshToken: {
      hash: 'hash-1',
      sessionId: session.id,
      issuedAt: T0,
      expiresAt: T0 + HOUR,
      consumedAt: null,
    },
  };
}

export function sqliteSuites(name: string, db: Driver): void {
  sessionStoreContract(
    `SqliteSessionStore (${name})`,
    async () => new SqliteSessionStore({ client: await db.fresh() }),
  );
  revocationStoreContract(
    `SqliteAccessTokenRevocationStore (${name})`,
    (clock) =>
      lazyRevocationStore(
        async () =>
          new SqliteAccessTokenRevocationStore({
            client: await db.fresh(),
            clock,
          }),
      ),
  );

  describe(`concurrent rotation (${name})`, () => {
    async function race(stores: SqliteSessionStore[], reuseGraceMs: number) {
      await stores[0]!.create(newSession());
      return Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          stores[i % stores.length]!.rotate({
            presentedHash: 'hash-1',
            newHash: `hash-next-${i}`,
            now: T0 + 1000,
            refreshTtlMs: HOUR,
            reuseGraceMs,
          }),
        ),
      ).then((results) => results.map((r) => r.status));
    }

    const connections: [string, () => Promise<SqliteClient[]>][] = [
      ['one connection', async () => [await db.fresh()]],
    ];
    const { pair } = db;
    if (pair) connections.push(['two connections', pair]);

    for (const [label, open] of connections) {
      const stores = async () =>
        (await open()).map((client) => new SqliteSessionStore({ client }));

      it(`lets exactly one of many rotations win without a grace window (${label})`, async () => {
        const statuses = await race(await stores(), 0);

        expect(statuses.filter((s) => s === 'rotated')).toHaveLength(1);
        expect(
          statuses.every((s) =>
            ['rotated', 'reuse_detected', 'session_revoked'].includes(s),
          ),
        ).toBe(true);
      });

      it(`lets all of them win inside the grace window (${label})`, async () => {
        const statuses = await race(await stores(), 10_000);

        expect(statuses.every((s) => s === 'rotated')).toBe(true);
      });
    }
  });

  describe(`SqliteSessionStore (${name}) storage`, () => {
    const store = async () => {
      const client = await db.fresh();
      return { client, store: new SqliteSessionStore({ client }) };
    };

    it('round-trips claims with empty arrays, nested objects and non-ASCII text', async () => {
      const { store: s } = await store();
      const claims = {
        roles: [],
        name: 'Zoë 🙂',
        org: { id: 'o-1', tags: [] },
      };
      await s.create(newSession({ claims, subject: 'ユーザー' }));

      expect((await s.find('session-1'))?.claims).toEqual(claims);
      expect(await s.listForSubject('ユーザー', T0)).toHaveLength(1);
    });

    it('keeps millisecond timestamps exact', async () => {
      const { store: s } = await store();
      const session = newSession({
        createdAt: T0 + 1,
        lastRefreshedAt: T0 + 999,
        expiresAt: 8_640_000_000_000_000 - 7,
        revokedAt: T0 + 5,
      });
      await s.create(session);

      expect(await s.find('session-1')).toEqual(session.session);
    });

    it('compares subjects and ids exactly: no case folding or trailing spaces', async () => {
      const { store: s } = await store();
      await s.create(newSession());

      expect(await s.listForSubject('USER-1', T0)).toEqual([]);
      expect(await s.listForSubject('user-1 ', T0)).toEqual([]);
      expect(await s.find('SESSION-1')).toBeNull();
      expect(await s.revokeAllForSubject('User-1', T0)).toEqual([]);
    });

    it('rejects a token hash that already exists and leaves no session behind', async () => {
      const { store: s } = await store();
      await s.create(newSession());

      await expect(s.create(newSession({ id: 'session-2' }))).rejects.toThrow();
      expect(await s.find('session-2')).toBeNull();
    });

    it('purges refresh tokens with their sessions even without foreign key enforcement', async () => {
      const { client, store: s } = await store();
      await s.create(newSession({ expiresAt: T0 + 1000 }));

      expect(await s.purgeExpired(T0 + 1000)).toBe(1);
      expect(
        await client.all('SELECT hash FROM "toklyn_refresh_tokens"', []),
      ).toEqual([]);
    });

    it('uses its own tables per prefix and migrates more than once', async () => {
      const client = await db.fresh();
      await migrate(client, { tablePrefix: 'other_' });
      await migrate(client, { tablePrefix: 'other_' });
      const main = new SqliteSessionStore({ client });
      const other = new SqliteSessionStore({ client, tablePrefix: 'other_' });
      await main.create(newSession());

      expect(await other.find('session-1')).toBeNull();
      expect(await main.find('session-1')).not.toBeNull();
    });
  });
}
