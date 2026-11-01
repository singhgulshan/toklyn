import type { Session } from 'toklyn';

export interface AppClaims {
  role: string;
}

export interface User {
  id: string;
  username: string;
  password: string;
  role: string;
  active: boolean;
}

// Demo only: replace with your user table and a password hash check (argon2id, bcrypt).
export const users = new Map<string, User>([
  [
    'user-1',
    {
      id: 'user-1',
      username: 'demo',
      password: 'demo',
      role: 'admin',
      active: true,
    },
  ],
]);

export function findUser(username: unknown, password: unknown): User | null {
  for (const user of users.values()) {
    if (
      user.active &&
      user.username === username &&
      user.password === password
    ) {
      return user;
    }
  }
  return null;
}

/**
 * The `onRefresh` hook: a disabled or deleted user is signed out at the next refresh, and a
 * role change reaches the next access token.
 */
export function checkUserOnRefresh(
  session: Session<AppClaims>,
): AppClaims | null | undefined {
  const user = users.get(session.subject);
  if (!user?.active) return null;
  if (user.role !== session.claims.role) return { role: user.role };
  return undefined;
}
