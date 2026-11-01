import { randomBytes } from 'node:crypto';
import { MemorySessionStore, accessTokensFromEnv, createAuth } from 'toklyn';
import { createApp } from './app.ts';
import { checkUserOnRefresh } from './users.ts';
import type { AppClaims } from './users.ts';

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
  onRefresh: checkUserOnRefresh,
});

const app = createApp(auth);
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Open http://localhost:${port} (user: demo, password: demo)`);
});
