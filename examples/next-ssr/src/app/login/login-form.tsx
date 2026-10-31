'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';

export function LoginForm({ returnTo }: Readonly<{ returnTo: string }>) {
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password'),
      }),
    });
    if (!response.ok) {
      setError('Wrong username or password.');
      return;
    }
    // A full load so the server renders with the new cookies.
    window.location.assign(returnTo);
  }

  return (
    <form onSubmit={onSubmit}>
      <input name="username" placeholder="username" autoComplete="username" />
      <input
        name="password"
        type="password"
        placeholder="password"
        autoComplete="current-password"
      />
      <button type="submit">Sign in</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
