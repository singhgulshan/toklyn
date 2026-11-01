import { createToklynFastify, getAuth, getOptionalAuth } from '@toklyn/fastify';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MemorySessionStore, accessTokensFromEnv, createAuth } from 'toklyn';

interface AppClaims {
  role: string;
}

if (!process.env.TOKLYN_SECRET) {
  // Demo fallback so `pnpm start` works without setup: everyone is signed out on restart.
  console.warn('TOKLYN_SECRET is not set; using a random secret for this run');
  process.env.TOKLYN_SECRET = randomBytes(32).toString('base64');
}

const auth = createAuth<AppClaims>({
  ...accessTokensFromEnv(),
  sessions: new MemorySessionStore(),
  accessTokenTtlSeconds: 60,
  refreshTokenTtlSeconds: 60 * 60,
  sessionMaxAgeSeconds: 24 * 60 * 60,
});

const toklyn = createToklynFastify(auth);

// Demo only: replace with your user lookup and a password hash check.
function findUser(
  username: unknown,
  password: unknown,
): { id: string; role: string } | null {
  return username === 'demo' && password === 'demo'
    ? { id: 'user-1', role: 'admin' }
    : null;
}

const app = Fastify({ bodyLimit: 1024 });

const page =
  (file: string, type: string) =>
  async (_request: unknown, reply: FastifyReply) =>
    reply
      .type(type)
      .send(await readFile(new URL(`../public/${file}`, import.meta.url)));
app.get('/', page('index.html', 'text/html; charset=utf-8'));
app.get('/app.js', page('app.js', 'text/javascript; charset=utf-8'));

app.post('/api/login', async (request, reply) => {
  const body: unknown = request.body;
  const { username, password } =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const user = findUser(username, password);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  const tokens = await auth.createSession({
    subject: user.id,
    claims: { role: user.role },
  });
  return toklyn.sendSession(reply, tokens);
});

app.post('/api/refresh', toklyn.refreshHandler);
app.post('/api/logout', toklyn.logoutHandler);

app.get('/api/me', { preHandler: toklyn.requireAuth }, async (request) => {
  const { sub, sid, role, exp } = getAuth<AppClaims>(request);
  return { sub, sid, role, exp };
});

// Guests get the public view; signed-in users get theirs. Bad tokens still get 401.
app.get(
  '/api/greeting',
  { preHandler: toklyn.optionalAuth() },
  async (request) => {
    const claims = getOptionalAuth<AppClaims>(request);
    return {
      message: claims ? `Welcome back, ${claims.sub}` : 'Hello, guest',
    };
  },
);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port });
console.log(`Open http://localhost:${port} (user: demo, password: demo)`);
