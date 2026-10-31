import { auth, toklyn } from '@/lib/auth';

export const DELETE = toklyn.withAuth<
  Request,
  RouteContext<'/api/sessions/[id]'>
>(async (_request, { params, claims }) => {
  const { id } = await params;
  const owned = await auth.listSessions(claims.sub);
  if (!owned.some((session) => session.id === id)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  await auth.revokeSession(id);
  return new Response(null, { status: 204 });
});
