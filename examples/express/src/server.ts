import { createToklynExpress, getAuth } from '@toklyn/express';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  JwtAccessTokenSigner,
  JwtAccessTokenVerifier,
  MemorySessionStore,
  createAuth,
} from 'toklyn';

interface AppClaims {
  role: string;
}

// A fresh key per start logs everyone out on restart; load a stored secret in production.
const keyConfig = {
  keys: [{ algorithm: 'HS256' as const, secret: randomBytes(32) }],
};

const auth = createAuth<AppClaims>({
  signer: new JwtAccessTokenSigner(keyConfig),
  verifier: new JwtAccessTokenVerifier(keyConfig),
  sessions: new MemorySessionStore(),
  accessTokenTtlSeconds: 60,
  refreshTokenTtlSeconds: 60 * 60,
  sessionMaxAgeSeconds: 24 * 60 * 60,
});

const toklyn = createToklynExpress(auth);

// Demo only: replace with your user lookup and a password hash check.
function findUser(
  username: unknown,
  password: unknown,
): { id: string; role: string } | null {
  return username === 'demo' && password === 'demo'
    ? { id: 'user-1', role: 'admin' }
    : null;
}

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
  });
  toklyn.sendSession(res, tokens);
});

app.post('/api/refresh', toklyn.refreshHandler);
app.post('/api/logout', toklyn.logoutHandler);

app.get('/api/me', toklyn.requireAuth, (req, res) => {
  const { sub, sid, role, exp } = getAuth<AppClaims>(req);
  res.json({ sub, sid, role, exp });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Open http://localhost:${port} (user: demo, password: demo)`);
});
