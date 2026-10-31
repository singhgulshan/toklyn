import { auth, toklyn } from '@/lib/auth';

export const GET = toklyn.withAuth(async (_request, { claims }) => {
  const sessions = await auth.listSessions(claims.sub);
  return Response.json(
    sessions.map(({ id, createdAt, expiresAt }) => ({
      id,
      createdAt,
      expiresAt,
      current: id === claims.sid,
    })),
  );
});
