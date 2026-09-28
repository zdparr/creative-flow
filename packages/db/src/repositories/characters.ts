import type { CardContent } from '@storyforge/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  characterVersions,
  characters,
  chronicleEvents,
  knowledgeEntries,
  ledgerFacts,
  locations,
  projects,
  promises,
} from '../schema.js';

export type CharacterRow = typeof characters.$inferSelect;
export type CharacterVersionRow = typeof characterVersions.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;

const norm = (s: string) => s.trim().toLowerCase();

/** Replaces one id with another in a uuid[] column, without leaving duplicates. */
const replaceId = (column: unknown, from: string, to: string) =>
  sql`array(select distinct unnest(array_replace(${column}, ${from}::uuid, ${to}::uuid)))`;

export function createCharacterRepo(db: Db) {
  return {
    list(projectId: string): Promise<CharacterRow[]> {
      return db
        .select()
        .from(characters)
        .where(eq(characters.projectId, projectId))
        .orderBy(characters.createdAt);
    },

    async get(id: string): Promise<CharacterRow | null> {
      const [row] = await db.select().from(characters).where(eq(characters.id, id));
      return row ?? null;
    },

    /** The character, only if its project belongs to this user. */
    async getForUser(id: string, userId: string): Promise<CharacterRow | null> {
      const [row] = await db
        .select({ character: characters })
        .from(characters)
        .innerJoin(projects, eq(characters.projectId, projects.id))
        .where(and(eq(characters.id, id), eq(projects.userId, userId)));
      return row?.character ?? null;
    },

    async create(
      values: Pick<CharacterRow, 'projectId' | 'name' | 'tier' | 'status'> &
        Partial<Pick<CharacterRow, 'aliases' | 'firstChapter'>>,
    ): Promise<CharacterRow> {
      const [row] = await db.insert(characters).values(values).returning();
      return row!;
    },

    async update(
      id: string,
      patch: Partial<Pick<CharacterRow, 'name' | 'aliases' | 'tier' | 'status'>>,
    ): Promise<CharacterRow> {
      const [row] = await db.update(characters).set(patch).where(eq(characters.id, id)).returning();
      return row!;
    },

    async delete(id: string): Promise<void> {
      await db.delete(characters).where(eq(characters.id, id));
    },

    /** Finds a character by name, alias, or first name, case-insensitively. */
    findByName(list: CharacterRow[], name: string): CharacterRow | undefined {
      const n = norm(name);
      return (
        list.find((c) => norm(c.name) === n || c.aliases.some((a) => norm(a) === n)) ??
        list.find((c) => norm(c.name).split(' ')[0] === n)
      );
    },

    // ---------- card versions ----------

    versions(characterId: string): Promise<CharacterVersionRow[]> {
      return db
        .select()
        .from(characterVersions)
        .where(eq(characterVersions.characterId, characterId))
        .orderBy(desc(characterVersions.version));
    },

    listVersionsForProject(projectId: string): Promise<CharacterVersionRow[]> {
      return db
        .select()
        .from(characterVersions)
        .where(eq(characterVersions.projectId, projectId))
        .orderBy(desc(characterVersions.version));
    },

    async createVersion(values: {
      projectId: string;
      characterId: string;
      effectiveChapter: number;
      card: CardContent;
      source: string;
      approved: boolean;
    }): Promise<CharacterVersionRow> {
      const { approved, ...rest } = values;
      const [row] = await db
        .insert(characterVersions)
        .values({
          ...rest,
          approvedAt: approved ? new Date() : null,
          version: sql`(select coalesce(max(${characterVersions.version}), 0) + 1 from ${characterVersions} where ${characterVersions.characterId} = ${values.characterId})`,
        })
        .returning();
      return row!;
    },

    async approveVersion(id: string, card?: CardContent): Promise<void> {
      await db
        .update(characterVersions)
        .set({ approvedAt: new Date(), ...(card ? { card } : {}) })
        .where(eq(characterVersions.id, id));
    },

    /** Replaces the card on a pending version (an author edit before approval). */
    async updatePendingCard(id: string, card: CardContent): Promise<void> {
      await db.update(characterVersions).set({ card }).where(eq(characterVersions.id, id));
    },

    // ---------- merge ----------

    /** Folds a duplicate into an existing character: references move, the name becomes an alias. */
    async merge(duplicate: CharacterRow, into: CharacterRow): Promise<CharacterRow> {
      const aliases = [...new Set([...into.aliases, duplicate.name, ...duplicate.aliases])].filter(
        (a) => norm(a) !== norm(into.name),
      );
      await db
        .update(chronicleEvents)
        .set({ characters: replaceId(chronicleEvents.characters, duplicate.id, into.id) })
        .where(sql`${duplicate.id}::uuid = any(${chronicleEvents.characters})`);
      await db
        .update(ledgerFacts)
        .set({ entities: replaceId(ledgerFacts.entities, duplicate.id, into.id) })
        .where(sql`${duplicate.id}::uuid = any(${ledgerFacts.entities})`);
      await db
        .update(promises)
        .set({ entities: replaceId(promises.entities, duplicate.id, into.id) })
        .where(sql`${duplicate.id}::uuid = any(${promises.entities})`);
      await db
        .update(knowledgeEntries)
        .set({ characterId: into.id })
        .where(eq(knowledgeEntries.characterId, duplicate.id));
      await db.delete(characters).where(eq(characters.id, duplicate.id));
      const firsts = [into.firstChapter, duplicate.firstChapter].filter(
        (n): n is number => n !== null,
      );
      const [row] = await db
        .update(characters)
        .set({ aliases, firstChapter: firsts.length ? Math.min(...firsts) : null })
        .where(eq(characters.id, into.id))
        .returning();
      return row!;
    },

    /** Removes a rejected character from the chronicle's cast lists, then deletes it. */
    async reject(character: CharacterRow): Promise<void> {
      await db
        .update(chronicleEvents)
        .set({
          characters: sql`array_remove(${chronicleEvents.characters}, ${character.id}::uuid)`,
        })
        .where(sql`${character.id}::uuid = any(${chronicleEvents.characters})`);
      await db.delete(characters).where(eq(characters.id, character.id));
    },

    // ---------- locations ----------

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

export type CharacterRepo = ReturnType<typeof createCharacterRepo>;

/**
 * The card each character had as of a chapter: the newest approved version effective by then.
 * Characters with no approved version yet (provisional) fall back to their newest draft, so
 * they are usable in play.
 */
export function cardsAsOf(
  versions: CharacterVersionRow[],
  chapter: number,
): Map<string, CharacterVersionRow> {
  const result = new Map<string, CharacterVersionRow>();
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  for (const v of sorted) {
    if (result.has(v.characterId)) continue;
    if (v.approvedAt && v.effectiveChapter <= chapter) result.set(v.characterId, v);
  }
  for (const v of sorted) {
    if (!result.has(v.characterId)) result.set(v.characterId, v);
  }
  return result;
}

/** The newest version is pending when it has not been approved. */
export function pendingVersion(versions: CharacterVersionRow[]): CharacterVersionRow | null {
  const newest = [...versions].sort((a, b) => b.version - a.version)[0];
  return newest && !newest.approvedAt ? newest : null;
}
