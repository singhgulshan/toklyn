import type { NewSession, Session } from 'toklyn';
import { revocationStoreContract, sessionStoreContract } from 'toklyn/testing';
import { describe, expect, it } from 'vitest';
import {
  MySqlAccessTokenRevocationStore,
  MySqlSessionStore,
} from '#src/mysql/index.js';
import type { TestDatabase } from './mysql.js';
import {
  MARIADB_URL,
  MYSQL_URL,
  lazyRevocationStore,
  useServer,
} from './mysql.js';

const T0 = 1_700_000_000_123;
const HOUR = 3_600_000;

function contracts(name: string, db: TestDatabase) {
  sessionStoreContract(
    `MySqlSessionStore (${name})`,
    async () =>
      new MySqlSessionStore({
        client: db.client,
        database: db.database,
        tablePrefix: await db.freshPrefix(),
      }),
  );
  revocationStoreContract(
    `MySqlAccessTokenRevocationStore (${name})`,
    (clock) =>
      lazyRevocationStore(
        async () =>
          new MySqlAccessTokenRevocationStore({
            client: db.client,
            database: db.database,
            tablePrefix: await db.freshPrefix(),
            clock,
          }),
      ),
  );
}

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

function serverTests(server: string, db: TestDatabase) {
  const store = async () =>
    new MySqlSessionStore({
      client: db.client,
      database: db.database,
      tablePrefix: await db.freshPrefix(),
    });

  describe(`concurrent rotation on ${server}`, () => {
    async function race(reuseGraceMs: number) {
      const s = await store();
      await s.create(newSession());
      return Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          s.rotate({
            presentedHash: 'hash-1',
            newHash: `hash-next-${i}`,
            now: T0 + 1000,
            refreshTtlMs: HOUR,
            reuseGraceMs,
          }),
        ),
      );
    }

    it('lets exactly one of many rotations win without a grace window', async () => {
      const statuses = (await race(0)).map((r) => r.status);

      expect(statuses.filter((s) => s === 'rotated')).toHaveLength(1);
      expect(
        statuses.every((s) =>
          ['rotated', 'reuse_detected', 'session_revoked'].includes(s),
        ),
      ).toBe(true);
    });

    it('lets all of them win inside the grace window', async () => {
      const statuses = (await race(10_000)).map((r) => r.status);

      expect(statuses.every((s) => s === 'rotated')).toBe(true);
    });
  });

  describe(`MySqlSessionStore on ${server}`, () => {
    it('round-trips claims with empty arrays, nested objects and non-ASCII text', async () => {
      const s = await store();
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
      const s = await store();
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
      const s = await store();
      await s.create(newSession());

      expect(await s.listForSubject('USER-1', T0)).toEqual([]);
      expect(await s.listForSubject('user-1 ', T0)).toEqual([]);
      expect(await s.find('SESSION-1')).toBeNull();
      expect(await s.revokeAllForSubject('User-1', T0)).toEqual([]);
    });

    it('rejects a token hash that already exists and leaves no session behind', async () => {
      const s = await store();
      await s.create(newSession());

      await expect(s.create(newSession({ id: 'session-2' }))).rejects.toThrow();
      expect(await s.find('session-2')).toBeNull();
    });
  });
}

if (MYSQL_URL) {
  const server = useServer(MYSQL_URL);
  contracts('MySQL, tuple', server.tuple);
  contracts('MySQL, tuple, prepared', server.tuplePrepared);
  contracts('MySQL, direct', server.direct);
  serverTests('MySQL', server.tuple);
}

if (MARIADB_URL) {
  const server = useServer(MARIADB_URL);
  contracts('MariaDB, direct', server.direct);
  contracts('MariaDB, direct, prepared', server.directPrepared);
  contracts('MariaDB, tuple', server.tuple);
  serverTests('MariaDB', server.direct);
}

if (!MYSQL_URL && !MARIADB_URL) {
  it.skip('MySQL/MariaDB servers (set MYSQL_URL or MARIADB_URL)', () => {});
}
