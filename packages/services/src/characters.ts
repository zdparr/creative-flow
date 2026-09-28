import {
  type BibleContent,
  type CardContent,
  type CharacterAppearances,
  type CharacterCard,
  type CharacterTier,
  ConflictError,
  type ExtractorOutput,
  GateError,
  NotFoundError,
  TIER_RANK,
  cardFromCast,
  emptyCard,
  majorCardSchema,
  missingCardFields,
  normalizeCard,
  runCardDrafter,
  suggestPromotion,
} from '@storyforge/core';
import {
  type CharacterRow,
  type CharacterVersionRow,
  cardsAsOf,
  inTransaction,
  pendingVersion,
} from '@storyforge/db';
import { toBibleContent } from './bible.js';
import type { ServiceContext } from './context.js';

export interface DraftCardJobInput {
  projectId: string;
  characterId: string;
  tier: CharacterTier;
  notes?: string;
}

/** The chapter now being written: the first one not locked (or the last chapter). */
export async function currentChapterNumber(ctx: ServiceContext, projectId: string) {
  const chapters = await ctx.repos.chapters.listForProject(projectId);
  return chapters.find((c) => c.status !== 'locked')?.number ?? chapters.at(-1)?.number ?? 1;
}

/** Creates records and approved v1 cards for the bible's cast the first time they are needed. */
export async function ensureCast(ctx: ServiceContext, projectId: string, bible: BibleContent) {
  const existing = await ctx.repos.characters.list(projectId);
  for (const member of bible.world.cast) {
    if (ctx.repos.characters.findByName(existing, member.name)) continue;
    const character = await ctx.repos.characters.create({
      projectId,
      name: member.name,
      tier: member.tier,
      status: 'approved',
      firstChapter: 1,
    });
    // The author approved these fields with the bible.
    await ctx.repos.characters.createVersion({
      projectId,
      characterId: character.id,
      effectiveChapter: 1,
      card: cardFromCast(member),
      source: 'bible',
      approved: true,
    });
    existing.push(character);
  }
  await backfillCards(ctx, projectId, bible, existing);
  return existing;
}

/**
 * Characters created before cards were versioned (Phase 3) have no card. Gives each a v1 once:
 * the bible's fields for the cast (approved), an approved card for walk-ons, and a seed card
 * plus a drafting job for provisional minor and major characters.
 */
async function backfillCards(
  ctx: ServiceContext,
  projectId: string,
  bible: BibleContent,
  characters: CharacterRow[],
) {
  const versions = await ctx.repos.characters.listVersionsForProject(projectId);
  const carded = new Set(versions.map((v) => v.characterId));
  for (const [i, c] of characters.entries()) {
    if (carded.has(c.id)) continue;
    const member = bible.world.cast.find((m) => m.name.toLowerCase() === c.name.toLowerCase());
    const first = c.firstChapter ?? 1;
    const approved = !!member || c.tier === 'walk_on';
    await ctx.repos.characters.createVersion({
      projectId,
      characterId: c.id,
      effectiveChapter: first,
      card: member ? cardFromCast(member) : emptyCard(first),
      source: member ? 'bible' : 'detected',
      approved,
    });
    if (c.tier === 'walk_on' && c.status === 'provisional') {
      characters[i] = await ctx.repos.characters.update(c.id, { status: 'approved' });
    } else if (!approved) {
      await requestCardDraft(ctx, c, c.tier);
    }
  }
}

/** Cards as of a chapter, in the shape the context builder reads. */
export async function cardsForChapter(
  ctx: ServiceContext,
  projectId: string,
  characters: CharacterRow[],
  chapter: number,
): Promise<CharacterCard[]> {
  const byCharacter = cardsAsOf(
    await ctx.repos.characters.listVersionsForProject(projectId),
    chapter,
  );
  return characters.map((c) => ({
    id: c.id,
    name: c.name,
    tier: c.tier,
    card: { ...normalizeCard(byCharacter.get(c.id)?.card, c.firstChapter ?? 1) },
  }));
}

/**
 * A character newly named in play. Walk-ons are created with an approved card straight from
 * the extractor (the spec asks nothing of the author for them). Minor and major characters are
 * provisional: usable in play at once, with a card drafted by a job for the author to approve.
 */
export async function registerNewCharacter(
  ctx: ServiceContext,
  projectId: string,
  chapter: number,
  found: ExtractorOutput['newCharacters'][number],
  location: string | null,
): Promise<CharacterRow> {
  const walkOn = found.proposedTier === 'walk_on';
  const character = await ctx.repos.characters.create({
    projectId,
    name: found.name.trim(),
    tier: found.proposedTier,
    status: walkOn ? 'approved' : 'provisional',
    firstChapter: chapter,
  });
  await ctx.repos.characters.createVersion({
    projectId,
    characterId: character.id,
    effectiveChapter: chapter,
    card: { ...emptyCard(chapter), role: found.role, trait: found.trait, location: location ?? '' },
    source: 'detected',
    approved: walkOn,
  });
  if (!walkOn) await requestCardDraft(ctx, character, found.proposedTier);
  return character;
}

/** Enqueues the card drafter for a character at a tier (new, promoted, or regenerated with notes). */
export async function requestCardDraft(
  ctx: ServiceContext,
  character: CharacterRow,
  tier: CharacterTier,
  notes?: string,
) {
  const input: DraftCardJobInput = {
    projectId: character.projectId,
    characterId: character.id,
    tier,
    ...(notes?.trim() ? { notes: notes.trim() } : {}),
  };
  const job = await ctx.repos.jobs.create(character.projectId, 'character.draftCard', { ...input });
  await ctx.enqueue({ id: job.id, type: 'character.draftCard', data: { ...input } });
  return job;
}

/** The character.draftCard job: drafts the card and saves it as a pending version. */
export async function draftCard(ctx: ServiceContext, jobId: string, input: DraftCardJobInput) {
  const character = await ctx.repos.characters.get(input.characterId);
  if (!character) throw new NotFoundError('Character');
  const [project, bibleRow, versions, chronicle] = await Promise.all([
    ctx.repos.projects.get(character.projectId),
    ctx.repos.bibles.latest(character.projectId),
    ctx.repos.characters.versions(character.id),
    ctx.repos.play.listProjectChronicle(character.projectId),
  ]);
  if (!project || !bibleRow) throw new NotFoundError('Bible');
  const firstChapter = character.firstChapter ?? 1;
  const latest = versions[0];
  const card = await runCardDrafter(ctx.agentContext(project.id, { jobId }), {
    bible: toBibleContent(project, bibleRow),
    name: character.name,
    tier: input.tier,
    firstChapter,
    moments: chronicle
      .filter((r) => r.event.isCanon && r.event.characters.includes(character.id))
      .map((r) => `Chapter ${r.chapterNumber}: ${r.event.summary}`),
    ...(latest ? { existing: normalizeCard(latest.card, firstChapter) } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  });
  const promoted = TIER_RANK[input.tier] > TIER_RANK[character.tier];
  // A new character's card holds from their first scene; a promotion from the chapter now in play.
  const effectiveChapter =
    character.status === 'provisional' && !promoted
      ? firstChapter
      : await currentChapterNumber(ctx, project.id);
  const version = await inTransaction(ctx.db, async (repos) => {
    if (input.tier !== character.tier) {
      await repos.characters.update(character.id, { tier: input.tier });
    }
    return repos.characters.createVersion({
      projectId: project.id,
      characterId: character.id,
      effectiveChapter,
      card,
      source: 'drafted',
      approved: false,
    });
  });
  return version.id;
}

function appearances(
  character: CharacterRow,
  chronicle: Awaited<ReturnType<ServiceContext['repos']['play']['listProjectChronicle']>>,
): CharacterAppearances {
  const scenes = chronicle.filter(
    (r) => r.event.isCanon && r.event.characters.includes(character.id),
  );
  const names = [character.name, ...character.aliases].map((n) => n.toLowerCase());
  return {
    chapters: [...new Set(scenes.map((r) => r.chapterNumber))],
    inRequiredBeat: scenes.some((r) => r.event.beatIds.length > 0),
    inPromise: chronicle.some(
      (r) =>
        r.event.isCanon &&
        r.event.extracted.promises.some((p) =>
          p.entities.some((e) => names.includes(e.toLowerCase())),
        ),
    ),
  };
}

function versionView(v: CharacterVersionRow, firstChapter: number) {
  return {
    id: v.id,
    version: v.version,
    effectiveChapter: v.effectiveChapter,
    source: v.source,
    approvedAt: v.approvedAt,
    createdAt: v.createdAt,
    card: normalizeCard(v.card, firstChapter),
  };
}

/** A character with its current card, any pending draft, and what the author should do next. */
function characterView(
  c: CharacterRow,
  versions: CharacterVersionRow[],
  seen: CharacterAppearances,
  drafting: boolean,
) {
  const first = c.firstChapter ?? 1;
  const mine = versions.filter((v) => v.characterId === c.id);
  const pending = pendingVersion(mine);
  const approved = mine.find((v) => v.approvedAt) ?? null;
  const shown = pending ?? approved;
  const card = normalizeCard(shown?.card, first);
  // Protagonist and principal cast arrive approved with the bible, so they do not prompt promotion.
  const promotion = c.status === 'approved' && !pending ? suggestPromotion(c.tier, seen) : null;
  return {
    id: c.id,
    name: c.name,
    aliases: c.aliases,
    tier: c.tier,
    status: c.status,
    firstChapter: c.firstChapter,
    card,
    approvedVersion: approved ? versionView(approved, first) : null,
    pendingVersion: pending ? versionView(pending, first) : null,
    missing: missingCardFields(c.tier, card),
    needsApproval: c.tier !== 'walk_on' && (c.status === 'provisional' || !!pending),
    drafting,
    chapters: seen.chapters,
    promotion,
  };
}

export type CharacterView = ReturnType<typeof characterView>;

export async function listCharacters(ctx: ServiceContext, projectId: string) {
  const [characters, versions, chronicle, jobs] = await Promise.all([
    ctx.repos.characters.list(projectId),
    ctx.repos.characters.listVersionsForProject(projectId),
    ctx.repos.play.listProjectChronicle(projectId),
    ctx.repos.jobs.listActive(projectId, 'character.draftCard'),
  ]);
  const drafting = new Set(jobs.map((j) => (j.input as { characterId?: string }).characterId));
  return characters.map((c) =>
    characterView(c, versions, appearances(c, chronicle), drafting.has(c.id)),
  );
}

export async function getCharacter(ctx: ServiceContext, character: CharacterRow) {
  const [versions, chronicle, jobs] = await Promise.all([
    ctx.repos.characters.versions(character.id),
    ctx.repos.play.listProjectChronicle(character.projectId),
    ctx.repos.jobs.listActive(character.projectId, 'character.draftCard'),
  ]);
  const drafting = jobs.some(
    (j) => (j.input as { characterId?: string }).characterId === character.id,
  );
  return {
    ...characterView(character, versions, appearances(character, chronicle), drafting),
    versions: versions.map((v) => versionView(v, character.firstChapter ?? 1)),
  };
}

function parseCard(input: unknown, firstChapter: number): CardContent {
  const parsed = majorCardSchema.partial().safeParse(input);
  if (!parsed.success) {
    throw new GateError(
      'Card is malformed',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const card = normalizeCard(parsed.data, firstChapter);
  const clean = (list: string[]) => list.map((x) => x.trim()).filter(Boolean);
  card.principles = clean(card.principles);
  card.voiceSamples = clean(card.voiceSamples);
  return card;
}

function assertComplete(tier: CharacterTier, card: CardContent) {
  const missing = missingCardFields(tier, card);
  if (missing.length) {
    throw new GateError(
      `A ${tier.replace('_', '-')} card needs every required field`,
      missing.map((f) => `${f} is empty`),
    );
  }
}

/** Approves the pending card (with any edits) and the character itself. Required fields are enforced. */
export async function approveCharacter(
  ctx: ServiceContext,
  character: CharacterRow,
  cardInput?: unknown,
) {
  const versions = await ctx.repos.characters.versions(character.id);
  const pending = pendingVersion(versions);
  const first = character.firstChapter ?? 1;
  const card = cardInput
    ? parseCard(cardInput, first)
    : normalizeCard((pending ?? versions[0])?.card, first);
  assertComplete(character.tier, card);
  await inTransaction(ctx.db, async (repos) => {
    if (pending) await repos.characters.approveVersion(pending.id, card);
    else if (cardInput || versions.length === 0) {
      await repos.characters.createVersion({
        projectId: character.projectId,
        characterId: character.id,
        effectiveChapter: first,
        card,
        source: 'author',
        approved: true,
      });
    }
    if (character.status !== 'approved')
      await repos.characters.update(character.id, { status: 'approved' });
  });
}

export interface CharacterEdit {
  name?: string;
  aliases?: string[];
  tier?: CharacterTier;
  card?: unknown;
}

/**
 * An author edit. A card edit on a pending draft stays pending; on an approved card it becomes
 * a new approved version taking effect in the chapter now being written. Raising the tier asks
 * the drafter for only the missing fields.
 */
export async function editCharacter(
  ctx: ServiceContext,
  character: CharacterRow,
  edit: CharacterEdit,
) {
  const patch: Parameters<typeof ctx.repos.characters.update>[1] = {};
  if (edit.name?.trim()) patch.name = edit.name.trim();
  if (edit.aliases) patch.aliases = edit.aliases.map((a) => a.trim()).filter(Boolean);
  const raising = edit.tier && TIER_RANK[edit.tier] > TIER_RANK[character.tier];
  if (edit.tier && !raising) patch.tier = edit.tier;
  if (Object.keys(patch).length) await ctx.repos.characters.update(character.id, patch);

  if (edit.card !== undefined) {
    const first = character.firstChapter ?? 1;
    const card = parseCard(edit.card, first);
    const pending = pendingVersion(await ctx.repos.characters.versions(character.id));
    if (pending) await ctx.repos.characters.updatePendingCard(pending.id, card);
    else {
      assertComplete(patch.tier ?? character.tier, card);
      await ctx.repos.characters.createVersion({
        projectId: character.projectId,
        characterId: character.id,
        effectiveChapter: await currentChapterNumber(ctx, character.projectId),
        card,
        source: 'author',
        approved: true,
      });
    }
  }
  if (raising) await requestCardDraft(ctx, character, edit.tier!);
}

/** "This is the same person": folds a duplicate into an existing character. */
export async function mergeCharacter(ctx: ServiceContext, duplicate: CharacterRow, intoId: string) {
  if (duplicate.id === intoId) throw new GateError('Choose a different character to merge into');
  const into = await ctx.repos.characters.get(intoId);
  if (!into || into.projectId !== duplicate.projectId) throw new NotFoundError('Character');
  return inTransaction(ctx.db, (repos) => repos.characters.merge(duplicate, into));
}

/** Rejects a provisional character entirely: it leaves the chronicle's cast lists. */
export async function rejectCharacter(ctx: ServiceContext, character: CharacterRow) {
  if (character.status !== 'provisional') {
    throw new ConflictError(
      'Only a provisional character can be rejected; edit or merge it instead',
    );
  }
  await ctx.repos.characters.reject(character);
}

/** Minor and major characters in this chapter's canon scenes whose cards are not yet approved. */
export async function unapprovedCharactersIn(
  ctx: ServiceContext,
  projectId: string,
  chapterId: string,
) {
  const [chronicle, characters, versions] = await Promise.all([
    ctx.repos.play.listChronicle(chapterId),
    ctx.repos.characters.list(projectId),
    ctx.repos.characters.listVersionsForProject(projectId),
  ]);
  const present = new Set(chronicle.filter((e) => e.isCanon).flatMap((e) => e.characters));
  return characters.filter(
    (c) =>
      present.has(c.id) &&
      c.tier !== 'walk_on' &&
      (c.status === 'provisional' ||
        !!pendingVersion(versions.filter((v) => v.characterId === c.id))),
  );
}
