import { toklyn } from '@/lib/auth';
import Link from 'next/link';

export default async function HomePage() {
  const claims = await toklyn.getClaims();

  return (
    <main>
      <h1>toklyn + Next.js (server-rendered)</h1>
      {claims ? (
        <p>
          Signed in as {claims.sub}. <Link href="/dashboard">Dashboard</Link>
        </p>
      ) : (
        <p>
          Signed out. <Link href="/login">Sign in</Link>
        </p>
      )}
    </main>
  );
}
