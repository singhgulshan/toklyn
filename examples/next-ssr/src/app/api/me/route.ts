import { toklyn } from '@/lib/auth';

export const GET = toklyn.withAuth((_request, { claims }) =>
  Response.json({ sub: claims.sub, role: claims.role }),
);
