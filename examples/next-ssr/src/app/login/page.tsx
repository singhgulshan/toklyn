import { safeReturnPath } from '@/lib/auth';
import { LoginForm } from './login-form';

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { from } = await searchParams;
  return (
    <main>
      <h1>Sign in</h1>
      <p>Use demo / demo.</p>
      <LoginForm returnTo={safeReturnPath(from)} />
    </main>
  );
}
