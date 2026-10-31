import { toklyn } from '@/lib/auth';

export const GET = toklyn.withAuth((_request, { claims }) => {
  const { sub, sid, role, exp } = claims;
  return Response.json({ sub, sid, role, exp });
});
