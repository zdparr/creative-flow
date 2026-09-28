import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { users } from '../schema.js';

export interface UserRepo {
  findOrCreateByEmail(email: string): Promise<{ id: string; email: string }>;
  findById(id: string): Promise<{ id: string; email: string; displayName: string | null } | null>;
}

export function createUserRepo(db: Db): UserRepo {
  return {
    async findOrCreateByEmail(email) {
      const [row] = await db
        .insert(users)
        .values({ email, authProviderId: `email:${email}` })
        .onConflictDoUpdate({ target: users.email, set: { updatedAt: new Date() } })
        .returning({ id: users.id, email: users.email });
      if (!row) throw new Error('User upsert returned no row');
      return row;
    },
    async findById(id) {
      const [row] = await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, id));
      return row ?? null;
    },
  };
}
