import { createToklynExpress, getAuth, getOptionalAuth } from '@toklyn/express';
import express from 'express';
import { fileURLToPath } from 'node:url';
import type { Auth } from 'toklyn';
import { findUser } from './users.ts';
import type { AppClaims } from './users.ts';

/** The Express app, separate from `server.ts` so tests can run it with a test `auth`. */
export function createApp(auth: Auth<AppClaims>): express.Express {
  const toklyn = createToklynExpress(auth);
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  app.post('/api/login', async (req, res) => {
    const body: unknown = req.body;
    const { username, password } =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const user = findUser(username, password);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const tokens = await auth.createSession({
      subject: user.id,
      claims: { role: user.role },
      metadata: { userAgent: req.get('user-agent') ?? 'unknown' },
    });
    toklyn.sendSession(res, tokens);
  });

  app.post('/api/refresh', toklyn.refreshHandler);
  app.post('/api/logout', toklyn.logoutHandler);

  app.get('/api/me', toklyn.requireAuth, (req, res) => {
    const { sub, sid, role, exp } = getAuth<AppClaims>(req);
    res.json({ sub, sid, role, exp });
  });

  // Guests get the public view; signed-in users get theirs. Bad tokens still get 401.
  app.get('/api/greeting', toklyn.optionalAuth(), (req, res) => {
    const claims = getOptionalAuth<AppClaims>(req);
    res.json({
      message: claims ? `Welcome back, ${claims.sub}` : 'Hello, guest',
    });
  });

  // "Your devices": every active session of the user, with the current one marked.
  app.get('/api/sessions', toklyn.requireAuth, async (req, res) => {
    const { sub, sid } = getAuth<AppClaims>(req);
    const sessions = await auth.listSessions(sub);
    res.json(
      sessions.map((session) => ({
        id: session.id,
        current: session.id === sid,
        userAgent: session.metadata.userAgent,
        createdAt: session.createdAt,
        lastRefreshedAt: session.lastRefreshedAt,
      })),
    );
  });

  app.post(
    '/api/sessions/revoke-others',
    toklyn.requireAuth,
    async (req, res) => {
      const { sub, sid } = getAuth<AppClaims>(req);
      await auth.revokeOtherSessions(sub, sid);
      res.status(204).end();
    },
  );

  return app;
}
