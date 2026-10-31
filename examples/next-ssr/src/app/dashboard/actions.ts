'use server';

import { auth, toklyn } from '@/lib/auth';
import { revalidatePath } from 'next/cache';

export async function revokeSession(form: FormData): Promise<void> {
  const claims = await toklyn.requireClaims();
  const id = form.get('id');
  const owned = await auth.listSessions(claims.sub);
  if (typeof id === 'string' && owned.some((session) => session.id === id)) {
    await auth.revokeSession(id);
  }
  revalidatePath('/dashboard');
}
