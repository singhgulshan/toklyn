'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

interface SessionInfo {
  id: string;
  current: boolean;
}

export default function Home() {
  // The access token lives only in memory; the refresh token is an HttpOnly cookie.
  const accessToken = useRef<string | null>(null);
  const refreshing = useRef<Promise<boolean> | null>(null);
  const [output, setOutput] = useState('');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const show = (label: string, value: unknown) =>
    setOutput(`${label}\n${JSON.stringify(value, null, 2)}`);

  // One refresh at a time: a second request with the old cookie would look like reuse.
  function refresh(): Promise<boolean> {
    refreshing.current ??= fetch('/api/refresh', { method: 'POST' })
      .then(async (response) => {
        accessToken.current = response.ok
          ? ((await response.json()) as { accessToken: string }).accessToken
          : null;
        return accessToken.current !== null;
      })
      .finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  }

  async function api(path: string, init: RequestInit = {}) {
    const call = () =>
      fetch(path, {
        ...init,
        headers: accessToken.current
          ? { authorization: `Bearer ${accessToken.current}` }
          : {},
      });
    let response = await call();
    if (response.status === 401 && (await refresh())) response = await call();
    return response;
  }

  useEffect(() => {
    // Restores the session after a page reload.
    void refresh().then((ok) => show('session restored on load', ok));
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(form)),
    });
    const body = (await response.json()) as { accessToken?: string };
    accessToken.current = body.accessToken ?? null;
    show(`login: ${response.status}`, body);
  }

  async function me() {
    const response = await api('/api/me');
    show(`me: ${response.status}`, await response.json());
  }

  async function listSessions() {
    const response = await api('/api/sessions');
    const body: unknown = await response.json();
    setSessions(response.ok ? (body as SessionInfo[]) : []);
    show(`sessions: ${response.status}`, body);
  }

  async function revoke(id: string) {
    const response = await api(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    show(`revoke: ${response.status}`, null);
    await listSessions();
  }

  async function logout() {
    const response = await fetch('/api/logout', { method: 'POST' });
    accessToken.current = null;
    setSessions([]);
    show(`logout: ${response.status}`, null);
  }

  return (
    <main>
      <h1>toklyn + Next.js</h1>
      <form onSubmit={login}>
        <input name="username" defaultValue="demo" autoComplete="username" />
        <input
          name="password"
          type="password"
          defaultValue="demo"
          autoComplete="current-password"
        />
        <button>Log in</button>
      </form>
      <p>
        <button onClick={me}>GET /api/me</button>
        <button onClick={listSessions}>GET /api/sessions</button>
        <button onClick={logout}>Log out</button>
      </p>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            {session.id} {session.current ? '(this one)' : ''}{' '}
            <button onClick={() => revoke(session.id)}>Revoke</button>
          </li>
        ))}
      </ul>
      <pre>{output}</pre>
    </main>
  );
}
