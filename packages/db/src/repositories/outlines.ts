import type { OutlineChapter } from '@storyforge/core';
import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { chapters, outlineChapters, outlines } from '../schema.js';

export type OutlineRow = typeof outlines.$inferSelect;
export interface OutlineWithChapters {
  outline: OutlineRow;
  chapters: OutlineChapter[];
  /** Row ids of the chapters above, in the same order. */
  chapterIds: string[];
}

function toDomain(row: typeof outlineChapters.$inferSelect): OutlineChapter {
  return {
    number: row.number,
    title: row.title,
    purpose: row.purpose,
    requiredBeats: row.requiredBeats,
    arcsMoved: row.arcsMoved,
    isAnchor: row.isAnchor,
    anchorType: row.anchorType ?? null,
    promises: row.promises,
  };
}

// Every generation, re-plan, or author edit is a new outline version.
export function createOutlineRepo(db: Db) {
  async function withChapters(outline: OutlineRow): Promise<OutlineWithChapters> {
    const rows = await db
      .select()
      .from(outlineChapters)
      .where(eq(outlineChapters.outlineId, outline.id))
      .orderBy(asc(outlineChapters.number));
    return { outline, chapters: rows.map(toDomain), chapterIds: rows.map((r) => r.id) };
  }

  return {
    async latest(projectId: string): Promise<OutlineWithChapters | null> {
      const [outline] = await db
        .select()
        .from(outlines)
        .where(eq(outlines.projectId, projectId))
        .orderBy(desc(outlines.version))
        .limit(1);
      return outline ? withChapters(outline) : null;
    },

    listVersions(projectId: string) {
      return db
        .select({
          id: outlines.id,
          version: outlines.version,
          createdAt: outlines.createdAt,
          approvedAt: outlines.approvedAt,
        })
        .from(outlines)
        .where(eq(outlines.projectId, projectId))
        .orderBy(desc(outlines.version));
    },

    async getVersion(projectId: string, version: number): Promise<OutlineWithChapters | null> {
      const rows = await db.select().from(outlines).where(eq(outlines.projectId, projectId));
      const outline = rows.find((r) => r.version === version);
      return outline ? withChapters(outline) : null;
    },

    async createVersion(projectId: string, list: OutlineChapter[]): Promise<OutlineWithChapters> {
      const outline = await db.transaction(async (tx) => {
        const [prev] = await tx
          .select({ version: outlines.version })
          .from(outlines)
          .where(eq(outlines.projectId, projectId))
          .orderBy(desc(outlines.version))
          .limit(1);
        const [outline] = await tx
          .insert(outlines)
          .values({ projectId, version: (prev?.version ?? 0) + 1 })
          .returning();
        if (list.length > 0) {
          await tx
            .insert(outlineChapters)
            .values(list.map((c) => ({ projectId, outlineId: outline!.id, ...c })));
        }
        return outline!;
      });
      // Read back after commit: `withChapters` uses the outer connection, not `tx`.
      return withChapters(outline);
    },

    async markApproved(id: string): Promise<void> {
      await db.update(outlines).set({ approvedAt: new Date() }).where(eq(outlines.id, id));
    },

    /** Creates the live chapter records for an approved outline. */
    async createChapters(projectId: string, approved: OutlineWithChapters): Promise<void> {
      await db.insert(chapters).values(
        approved.chapters.map((c, i) => ({
          projectId,
          number: c.number,
          outlineChapterId: approved.chapterIds[i]!,
        })),
      );
    },

    listChapters(projectId: string) {
      return db
        .select()
        .from(chapters)
        .where(eq(chapters.projectId, projectId))
        .orderBy(asc(chapters.number));
    },
  };
}
