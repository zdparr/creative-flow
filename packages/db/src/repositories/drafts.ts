import { and, eq } from 'drizzle-orm';
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
  };
}
