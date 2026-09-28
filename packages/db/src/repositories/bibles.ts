import type { Spine, StyleGuide, World } from '@storyforge/core';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { bibles } from '../schema.js';

export type BibleRow = typeof bibles.$inferSelect;
export interface BibleSections {
  spine: Spine;
  world: World;
  styleGuide: StyleGuide;
}

// Every edit, regeneration, or draft is a new version; approval stamps the latest one.
export function createBibleRepo(db: Db) {
  return {
    async latest(projectId: string): Promise<BibleRow | null> {
      const [row] = await db
        .select()
        .from(bibles)
        .where(eq(bibles.projectId, projectId))
        .orderBy(desc(bibles.version))
        .limit(1);
      return row ?? null;
    },

    listVersions(projectId: string) {
      return db
        .select({
          id: bibles.id,
          version: bibles.version,
          createdAt: bibles.createdAt,
          approvedAt: bibles.approvedAt,
        })
        .from(bibles)
        .where(eq(bibles.projectId, projectId))
        .orderBy(desc(bibles.version));
    },

    async getVersion(projectId: string, version: number): Promise<BibleRow | null> {
      const [row] = await db
        .select()
        .from(bibles)
        .where(and(eq(bibles.projectId, projectId), eq(bibles.version, version)));
      return row ?? null;
    },

    async createVersion(projectId: string, sections: BibleSections): Promise<BibleRow> {
      const latest = await this.latest(projectId);
      const [row] = await db
        .insert(bibles)
        .values({ projectId, version: (latest?.version ?? 0) + 1, ...sections })
        .returning();
      return row!;
    },

    async markApproved(id: string): Promise<void> {
      await db.update(bibles).set({ approvedAt: new Date() }).where(eq(bibles.id, id));
    },
  };
}
