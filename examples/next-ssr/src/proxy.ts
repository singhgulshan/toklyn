import { toklyn } from '@/lib/auth';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  return toklyn.proxy(request);
}

export const config = {
  // Auth routes manage the cookies themselves, so the proxy must not refresh in front of them.
  matcher: ['/((?!api/auth/|_next/static|_next/image|favicon.ico).*)'],
};
