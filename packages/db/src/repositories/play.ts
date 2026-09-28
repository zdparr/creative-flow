import {
  type ChapterStatus,
  type ChronicleExtraction,
  ConflictError,
  assertChapterTransition,
} from '@storyforge/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  chapters,
  characters,
  chronicleEvents,
  locations,
  outlineChapters,
  playTurns,
  projects,
} from '../schema.js';

export type ChapterRow = typeof chapters.$inferSelect;
export type PlayTurn = typeof playTurns.$inferSelect;
export type ChronicleEvent = typeof chronicleEvents.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;

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

const norm = (s: string) => s.trim().toLowerCase();

export function createCharacterRepo(db: Db) {
  return {
    list(projectId: string): Promise<CharacterRow[]> {
      return db.select().from(characters).where(eq(characters.projectId, projectId));
    },

    async create(
      values: Pick<CharacterRow, 'projectId' | 'name' | 'tier' | 'status'> &
        Partial<Pick<CharacterRow, 'aliases' | 'firstChapter'>>,
    ): Promise<CharacterRow> {
      const [row] = await db.insert(characters).values(values).returning();
      return row!;
    },

    /** Finds a character by name or alias, case-insensitively. */
    findByName(list: CharacterRow[], name: string): CharacterRow | undefined {
      const n = norm(name);
      return list.find(
        (c) =>
          norm(c.name) === n ||
          c.aliases.some((a) => norm(a) === n) ||
          norm(c.name).split(' ')[0] === n,
      );
    },

    listLocations(projectId: string): Promise<LocationRow[]> {
      return db.select().from(locations).where(eq(locations.projectId, projectId));
    },

    /** Returns the location with this name, creating it on first mention. */
    async ensureLocation(projectId: string, name: string, chapter: number): Promise<LocationRow> {
      const existing = (await this.listLocations(projectId)).find(
        (l) => norm(l.name) === norm(name),
      );
      if (existing) return existing;
      const [row] = await db
        .insert(locations)
        .values({ projectId, name: name.trim(), firstChapter: chapter })
        .returning();
      return row!;
    },
  };
}
