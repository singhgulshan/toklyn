import { auth, toklyn } from '@/lib/auth';
import { revokeSession } from './actions';
import { LogoutButton } from './logout-button';

export default async function DashboardPage() {
  const claims = await toklyn.requireClaims();
  const sessions = await auth.listSessions(claims.sub);

  return (
    <main>
      <h1>Dashboard</h1>
      <p>
        Rendered on the server for {claims.sub} ({claims.role}). Access token
        expires at {new Date(claims.exp * 1000).toLocaleTimeString()}.
      </p>
      <h2>Sessions</h2>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            {new Date(session.createdAt).toLocaleString()}{' '}
            {session.id === claims.sid ? (
              <strong>(this browser)</strong>
            ) : (
              <form action={revokeSession} style={{ display: 'inline' }}>
                <input type="hidden" name="id" value={session.id} />
                <button type="submit">Revoke</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <LogoutButton />
    </main>
  );
}
