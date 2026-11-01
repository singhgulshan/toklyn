import type { AddressInfo } from 'node:net';
import { createTestAuth } from 'toklyn/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { checkUserOnRefresh, users } from '../src/users.ts';
import type { AppClaims } from '../src/users.ts';

// How to test your own app: a test auth (random key, memory stores, controllable clock)
// passed to the same createApp the server uses.
const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  const demo = users.get('user-1');
  if (demo) Object.assign(demo, { role: 'admin', active: true });
});

async function start() {
  const { auth, clock } = createTestAuth<AppClaims>({
    onRefresh: checkUserOnRefresh,
  });
  const server = createApp(auth).listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';

  // A tiny browser: remembers the refresh cookie and marks requests as same-origin.
  const call = async (
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) => {
    const response = await fetch(base + path, {
      ...init,
      headers: { 'sec-fetch-site': 'same-origin', cookie, ...init.headers },
    });
    const setCookie = response.headers.getSetCookie()[0];
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';
    return response;
  };
  const login = async () => {
    const response = await call('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'demo' }),
    });
    return ((await response.json()) as { accessToken: string }).accessToken;
  };
  const bearer = (token: string) => ({
    headers: { authorization: `Bearer ${token}` },
  });
  return { call, login, bearer, clock };
}

describe('express example', () => {
  it('signs in and returns the claims', async () => {
    const { call, login, bearer } = await start();
    const me = await call('/api/me', bearer(await login()));
    expect(await me.json()).toMatchObject({ sub: 'user-1', role: 'admin' });
  });

  it('needs a refresh once the access token expires', async () => {
    const { call, login, bearer, clock } = await start();
    const token = await login();

    clock.advance(16 * 60 * 1000);
    expect((await call('/api/me', bearer(token))).status).toBe(401);

    const refreshed = await call('/api/refresh', { method: 'POST' });
    const { accessToken } = (await refreshed.json()) as { accessToken: string };
    expect((await call('/api/me', bearer(accessToken))).status).toBe(200);
  });

  it('signs out a disabled user at the next refresh', async () => {
    const { call, login } = await start();
    await login();

    const demo = users.get('user-1');
    if (demo) demo.active = false;
    expect((await call('/api/refresh', { method: 'POST' })).status).toBe(401);
  });

  it('puts a role change into the next access token', async () => {
    const { call, login, bearer } = await start();
    await login();

    const demo = users.get('user-1');
    if (demo) demo.role = 'viewer';
    const refreshed = await call('/api/refresh', { method: 'POST' });
    const { accessToken } = (await refreshed.json()) as { accessToken: string };
    const me = await call('/api/me', bearer(accessToken));
    expect(await me.json()).toMatchObject({ role: 'viewer' });
  });

  it('greets guests and signed-in users', async () => {
    const { call, login, bearer } = await start();
    const guest = await call('/api/greeting');
    expect(await guest.json()).toEqual({ message: 'Hello, guest' });
    const member = await call('/api/greeting', bearer(await login()));
    expect(await member.json()).toEqual({ message: 'Welcome back, user-1' });
  });

  it('signs out other devices', async () => {
    const { call, login, bearer } = await start();
    await login();
    const current = await login();

    const before = await call('/api/sessions', bearer(current));
    expect(await before.json()).toHaveLength(2);
    await call('/api/sessions/revoke-others', {
      method: 'POST',
      ...bearer(current),
    });
    const after = await call('/api/sessions', bearer(current));
    expect(await after.json()).toEqual([
      expect.objectContaining({ current: true }),
    ]);
  });
});
