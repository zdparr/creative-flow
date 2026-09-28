import { ConflictError, type ProjectStatus, assertProjectTransition } from '@storyforge/core';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { projects } from '../schema.js';

export type Project = typeof projects.$inferSelect;

export function createProjectRepo(db: Db) {
  return {
    async create(userId: string, pitch: string, title: string): Promise<Project> {
      const [row] = await db
        .insert(projects)
        .values({ userId, createdFromPitch: pitch, title })
        .returning();
      return row!;
    },

    listForUser(userId: string): Promise<Project[]> {
      return db
        .select()
        .from(projects)
        .where(eq(projects.userId, userId))
        .orderBy(desc(projects.updatedAt));
    },

    async getForUser(id: string, userId: string): Promise<Project | null> {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, id), eq(projects.userId, userId)));
      return row ?? null;
    },

    async get(id: string): Promise<Project | null> {
      const [row] = await db.select().from(projects).where(eq(projects.id, id));
      return row ?? null;
    },

    async setTitle(id: string, title: string): Promise<void> {
      await db.update(projects).set({ title }).where(eq(projects.id, id));
    },

    /** Moves the project forward, failing if it is no longer in `from` (e.g. a double submit). */
    async transition(id: string, from: ProjectStatus, to: ProjectStatus): Promise<void> {
      assertProjectTransition(from, to);
      const updated = await db
        .update(projects)
        .set({ status: to })
        .where(and(eq(projects.id, id), eq(projects.status, from)))
        .returning({ id: projects.id });
      if (updated.length === 0) throw new ConflictError(`Project is no longer in ${from}`);
    },
  };
}
