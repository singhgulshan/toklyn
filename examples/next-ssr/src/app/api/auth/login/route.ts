import { auth, findUser, toklyn } from '@/lib/auth';

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const { username, password } =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const user = findUser(username, password);
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const tokens = await auth.createSession({
    subject: user.id,
    claims: { role: user.role },
  });
  return toklyn.sessionResponse(tokens);
}
