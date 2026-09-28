import {
  type ChapterStatus,
  type ChronicleExtraction,
  ConflictError,
  assertChapterTransition,
} from '@storyforge/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { chapters, chronicleEvents, outlineChapters, playTurns, projects } from '../schema.js';

export type ChapterRow = typeof chapters.$inferSelect;
export type PlayTurn = typeof playTurns.$inferSelect;
export type ChronicleEvent = typeof chronicleEvents.$inferSelect;

export function createChapterRepo(db: Db) {
  return {
    /** The chapter with its project, only if the project belongs to this user. */
    async getForUser(id: string, userId: string) {
      const [row] = await db
        .select({ chapter: chapters, project: projects })
        .from(chapters)
        .innerJoin(projects, eq(chapters.projectId, projects.id))
        .where(and(eq(chapters.id, id), eq(projects.userId, userId)));
      return row ?? null;
    },

    async get(id: string): Promise<ChapterRow | null> {
      const [row] = await db.select().from(chapters).where(eq(chapters.id, id));
      return row ?? null;
    },

    listForProject(projectId: string) {
      return db
        .select({
          id: chapters.id,
          number: chapters.number,
          status: chapters.status,
          title: outlineChapters.title,
          purpose: outlineChapters.purpose,
          summary: chapters.summary,
          lockedAt: chapters.lockedAt,
        })
        .from(chapters)
        .leftJoin(outlineChapters, eq(chapters.outlineChapterId, outlineChapters.id))
        .where(eq(chapters.projectId, projectId))
        .orderBy(asc(chapters.number));
    },

    async plan(chapter: ChapterRow) {
      if (!chapter.outlineChapterId) return null;
      const [row] = await db
        .select()
        .from(outlineChapters)
        .where(eq(outlineChapters.id, chapter.outlineChapterId));
      return row ?? null;
    },

    async transition(id: string, from: ChapterStatus, to: ChapterStatus): Promise<void> {
      assertChapterTransition(from, to);
      const updated = await db
        .update(chapters)
        .set({ status: to })
        .where(and(eq(chapters.id, id), eq(chapters.status, from)))
        .returning({ id: chapters.id });
      if (updated.length === 0) throw new ConflictError(`Chapter is no longer ${from}`);
    },

    /** Locks a chapter from review (or re-confirms one flagged for recheck). */
    async markLocked(
      id: string,
      from: ChapterStatus,
      values: { summary: string | null; snapshotId: string },
    ): Promise<void> {
      assertChapterTransition(from, 'locked');
      const updated = await db
        .update(chapters)
        .set({
          status: 'locked',
          lockedAt: new Date(),
          lockedSnapshotId: values.snapshotId,
          ...(values.summary !== null ? { summary: values.summary } : {}),
        })
        .where(and(eq(chapters.id, id), eq(chapters.status, from)))
        .returning({ id: chapters.id });
      if (updated.length === 0) throw new ConflictError(`Chapter is no longer ${from}`);
    },

    /** Applies precomputed status changes (from planUnlock). */
    async setStatus(id: string, status: ChapterStatus): Promise<void> {
      await db.update(chapters).set({ status }).where(eq(chapters.id, id));
    },

    /** Points a chapter at its plan in a newer outline version. */
    async setOutlineChapter(id: string, outlineChapterId: string): Promise<void> {
      await db.update(chapters).set({ outlineChapterId }).where(eq(chapters.id, id));
    },

    async setManualBeats(id: string, beatIds: string[]): Promise<void> {
      await db.update(chapters).set({ manualBeats: beatIds }).where(eq(chapters.id, id));
    },
  };
}

export function createPlayRepo(db: Db) {
  return {
    listTurns(chapterId: string): Promise<PlayTurn[]> {
      return db
        .select()
        .from(playTurns)
        .where(eq(playTurns.chapterId, chapterId))
        .orderBy(asc(playTurns.seq));
    },

    /** Appends a turn with the next sequence number. */
    async addTurn(
      turn: Pick<PlayTurn, 'projectId' | 'chapterId' | 'role' | 'content'> &
        Partial<Pick<PlayTurn, 'inputKind' | 'tokens'>>,
    ): Promise<PlayTurn> {
      const [row] = await db
        .insert(playTurns)
        .values({
          ...turn,
          seq: sql`(select coalesce(max(${playTurns.seq}), 0) + 1 from ${playTurns} where ${playTurns.chapterId} = ${turn.chapterId})`,
        })
        .returning();
      return row!;
    },

    listChronicle(chapterId: string): Promise<ChronicleEvent[]> {
      return db
        .select()
        .from(chronicleEvents)
        .where(eq(chronicleEvents.chapterId, chapterId))
        .orderBy(asc(chronicleEvents.seq));
    },

    /** Every chronicle event in the project, with its chapter number, in story order. */
    listProjectChronicle(projectId: string) {
      return db
        .select({ event: chronicleEvents, chapterNumber: chapters.number })
        .from(chronicleEvents)
        .innerJoin(chapters, eq(chronicleEvents.chapterId, chapters.id))
        .where(eq(chronicleEvents.projectId, projectId))
        .orderBy(asc(chapters.number), asc(chronicleEvents.seq));
    },

    async lastChronicle(chapterId: string): Promise<ChronicleEvent | null> {
      const [row] = await db
        .select()
        .from(chronicleEvents)
        .where(eq(chronicleEvents.chapterId, chapterId))
        .orderBy(desc(chronicleEvents.seq))
        .limit(1);
      return row ?? null;
    },

    async addChronicle(event: {
      projectId: string;
      chapterId: string;
      turnIds: string[];
      summary: string;
      characters: string[];
      locationId: string | null;
      beatIds: string[];
      interiorityNote: string | null;
      extracted: ChronicleExtraction;
    }): Promise<ChronicleEvent> {
      const [row] = await db
        .insert(chronicleEvents)
        .values({
          ...event,
          seq: sql`(select coalesce(max(${chronicleEvents.seq}), 0) + 1 from ${chronicleEvents} where ${chronicleEvents.chapterId} = ${event.chapterId})`,
        })
        .returning();
      return row!;
    },

    async setCanon(chapterId: string, eventId: string, isCanon: boolean): Promise<void> {
      const updated = await db
        .update(chronicleEvents)
        .set({ isCanon })
        .where(and(eq(chronicleEvents.id, eventId), eq(chronicleEvents.chapterId, chapterId)))
        .returning({ id: chronicleEvents.id });
      if (updated.length === 0) throw new ConflictError('Chronicle event not found');
    },
  };
}
