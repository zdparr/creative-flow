import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { chapterDrafts } from '../schema.js';

export type ChapterDraft = typeof chapterDrafts.$inferSelect;

export function createDraftRepo(db: Db) {
  return {
    /** The chapter's current prose draft (the one approved at lock), if any. */
    async current(chapterId: string): Promise<ChapterDraft | null> {
      const [row] = await db
        .select()
        .from(chapterDrafts)
        .where(and(eq(chapterDrafts.chapterId, chapterId), eq(chapterDrafts.isCurrent, true)));
      return row ?? null;
    },

    async get(id: string): Promise<ChapterDraft | null> {
      const [row] = await db.select().from(chapterDrafts).where(eq(chapterDrafts.id, id));
      return row ?? null;
    },

    /** Every version, newest first, without the prose. */
    list(chapterId: string) {
      return db
        .select({
          id: chapterDrafts.id,
          version: chapterDrafts.version,
          wordCount: chapterDrafts.wordCount,
          notes: chapterDrafts.notes,
          isCurrent: chapterDrafts.isCurrent,
          createdAt: chapterDrafts.createdAt,
        })
        .from(chapterDrafts)
        .where(eq(chapterDrafts.chapterId, chapterId))
        .orderBy(desc(chapterDrafts.version));
    },

    async getVersion(chapterId: string, version: number): Promise<ChapterDraft | null> {
      const [row] = await db
        .select()
        .from(chapterDrafts)
        .where(and(eq(chapterDrafts.chapterId, chapterId), eq(chapterDrafts.version, version)));
      return row ?? null;
    },

    /**
     * Saves a new version and makes it current in one transaction, so a crash leaves the
     * previous draft current.
     */
    async create(values: {
      projectId: string;
      chapterId: string;
      prose: string;
      wordCount: number;
      notes: string | null;
      jobId: string | null;
    }): Promise<ChapterDraft> {
      return db.transaction(async (tx) => {
        await tx
          .update(chapterDrafts)
          .set({ isCurrent: false })
          .where(
            and(eq(chapterDrafts.chapterId, values.chapterId), eq(chapterDrafts.isCurrent, true)),
          );
        const [row] = await tx
          .insert(chapterDrafts)
          .values({
            ...values,
            isCurrent: true,
            version: sql`(select coalesce(max(${chapterDrafts.version}), 0) + 1 from ${chapterDrafts} where ${chapterDrafts.chapterId} = ${values.chapterId})`,
          })
          .returning();
        return row!;
      });
    },

    /** Current drafts for every chapter in the project. */
    listCurrentForProject(projectId: string): Promise<ChapterDraft[]> {
      return db
        .select()
        .from(chapterDrafts)
        .where(and(eq(chapterDrafts.projectId, projectId), eq(chapterDrafts.isCurrent, true)));
    },
  };
}
