import {
  type BeatStatus,
  type BibleContent,
  type CharacterCard,
  ConflictError,
  type ContextPromise,
  type ContextTurn,
  GateError,
  NotFoundError,
  type OutlineChapter,
  type ProtagonistInput,
  allBeatsHit,
  beatStatus,
  buildDirectorContext,
  buildNpcContext,
  runDirectorTurn,
  runExtractor,
  runNpcVoice,
} from '@storyforge/core';
import type { ChapterRow, CharacterRow, PlayTurn, Project } from '@storyforge/db';
import { toBibleContent } from './bible.js';
import type { ServiceContext } from './context.js';

/** Receives a turn as it happens; the API forwards these as server-sent events. */
export interface PlaySink {
  text(delta: string): void;
  npc(name: string): void;
  event(type: 'turn' | 'chronicle' | 'warning', data: unknown): void;
}

export const DIRECTOR_BUDGET_TOKENS = 60_000;

// One turn at a time per chapter. The web service runs as a single instance, so an
// in-process lock is enough; a second concurrent turn gets a clear conflict.
const inProgress = new Set<string>();

interface PlayData {
  project: Project;
  chapter: ChapterRow;
  plan: OutlineChapter;
  bible: BibleContent;
  characters: CharacterRow[];
  turns: PlayTurn[];
  beats: BeatStatus[];
}

function toPlan(
  row: NonNullable<Awaited<ReturnType<ServiceContext['repos']['chapters']['plan']>>>,
): OutlineChapter {
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

/** Creates character records for the bible's cast the first time a chapter is played. */
async function ensureCast(ctx: ServiceContext, projectId: string, bible: BibleContent) {
  const existing = await ctx.repos.characters.list(projectId);
  for (const member of bible.world.cast) {
    if (ctx.repos.characters.findByName(existing, member.name)) continue;
    existing.push(
      await ctx.repos.characters.create({
        projectId,
        name: member.name,
        tier: member.tier,
        status: 'approved',
      }),
    );
  }
  return existing;
}

async function load(ctx: ServiceContext, chapterId: string): Promise<PlayData> {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  const [project, planRow, bibleRow] = await Promise.all([
    ctx.repos.projects.get(chapter.projectId),
    ctx.repos.chapters.plan(chapter),
    ctx.repos.bibles.latest(chapter.projectId),
  ]);
  if (!project || !planRow || !bibleRow) throw new NotFoundError('Chapter plan');
  const bible = toBibleContent(project, bibleRow);
  const plan = toPlan(planRow);
  const [characters, turns, chronicle] = await Promise.all([
    ensureCast(ctx, project.id, bible),
    ctx.repos.play.listTurns(chapter.id),
    ctx.repos.play.listChronicle(chapter.id),
  ]);
  const canonBeats = chronicle.filter((e) => e.isCanon).flatMap((e) => e.beatIds);
  return {
    project,
    chapter,
    plan,
    bible,
    characters,
    turns,
    beats: beatStatus(plan, canonBeats, chapter.manualBeats),
  };
}

function cardFor(c: CharacterRow, bible: BibleContent): CharacterCard {
  const member = bible.world.cast.find((m) => m.name.toLowerCase() === c.name.toLowerCase());
  return { id: c.id, name: c.name, tier: c.tier, card: member ?? {} };
}

const protagonistName = (bible: BibleContent) =>
  bible.world.cast.find((m) => m.role === 'protagonist')?.name ?? bible.styleGuide.povCharacter;

/** Who is in the scene: the protagonist, characters this chapter's arcs name, and recent chronicle cast. */
async function sceneCharacters(ctx: ServiceContext, data: PlayData) {
  const chronicle = (await ctx.repos.play.listChronicle(data.chapter.id)).filter((e) => e.isCanon);
  const ids = new Set(chronicle.slice(-3).flatMap((e) => e.characters));
  for (const name of [
    protagonistName(data.bible),
    ...data.plan.arcsMoved.map((a) => a.character),
  ]) {
    const c = name ? ctx.repos.characters.findByName(data.characters, name) : undefined;
    if (c) ids.add(c.id);
  }
  return { ids: [...ids], locationId: chronicle.at(-1)?.locationId ?? null };
}

async function plannedPromises(ctx: ServiceContext, projectId: string): Promise<ContextPromise[]> {
  const outline = await ctx.repos.outlines.latest(projectId);
  return (outline?.chapters ?? []).flatMap((c) =>
    c.promises.planted.map((p) => ({
      description: p.description,
      plantedChapter: c.number,
      payoffChapter: p.payoffChapter,
      entities: [],
    })),
  );
}

const toContextTurn = (t: PlayTurn): ContextTurn => ({
  role: t.role,
  inputKind: t.inputKind,
  content: t.content,
});

async function runTurn(
  ctx: ServiceContext,
  data: PlayData,
  input: ProtagonistInput | null,
  authorTurn: PlayTurn | null,
  interiority: string | null,
  sink: PlaySink,
) {
  const agent = ctx.agentContext(data.project.id);
  const scene = await sceneCharacters(ctx, data);
  // Summaries are written at lock (Phase 5); they are the only form of old chapters play sees.
  const lockedSummaries = (await ctx.repos.chapters.listForProject(data.project.id)).flatMap((c) =>
    c.status === 'locked' && c.number < data.chapter.number && c.summary
      ? [{ number: c.number, summary: c.summary }]
      : [],
  );
  const context = buildDirectorContext(
    {
      bible: data.bible,
      chapterNumber: data.chapter.number,
      plan: data.plan,
      beats: data.beats,
      characters: data.characters.map((c) => cardFor(c, data.bible)),
      sceneCharacterIds: scene.ids,
      sceneLocationId: scene.locationId,
      turns: data.turns.map(toContextTurn),
      lockedSummaries,
      facts: [], // The continuity ledger is committed at lock (Phase 5).
      promises: await plannedPromises(ctx, data.project.id),
    },
    DIRECTOR_BUDGET_TOKENS,
  );

  const protagonist = protagonistName(data.bible)?.toLowerCase();
  const npcTurns: PlayTurn[] = [];
  const narration = await runDirectorTurn(agent, {
    context,
    input,
    onText: (delta) => sink.text(delta),
    voiceCharacter: async (name, situation) => {
      const character = ctx.repos.characters.findByName(data.characters, name);
      if (
        !character ||
        character.tier !== 'major' ||
        character.name.toLowerCase() === protagonist
      ) {
        return `${name} is not a major non-protagonist character. Voice them yourself.`;
      }
      const others = data.characters.filter(
        (c) => scene.ids.includes(c.id) && c.id !== character.id,
      );
      const voiced = await runNpcVoice(
        agent,
        buildNpcContext({
          character: cardFor(character, data.bible),
          knowledge: [], // The knowledge map is committed at lock (Phase 5).
          otherCharactersInScene: others.map((o) => ({ name: o.name, relationship: '' })),
          recentTurns: data.turns.map(toContextTurn),
          situation,
        }),
      );
      npcTurns.push(
        await ctx.repos.play.addTurn({
          projectId: data.project.id,
          chapterId: data.chapter.id,
          role: 'npc',
          content: `${character.name}: ${voiced.action}${voiced.dialogue ? ` "${voiced.dialogue}"` : ''}`,
        }),
      );
      sink.npc(character.name);
      return JSON.stringify(voiced);
    },
  });

  const directorTurn = await ctx.repos.play.addTurn({
    projectId: data.project.id,
    chapterId: data.chapter.id,
    role: 'director',
    content: narration,
  });
  sink.event('turn', { director: directorTurn });

  try {
    const previous = await ctx.repos.play.lastChronicle(data.chapter.id);
    const locations = await ctx.repos.characters.listLocations(data.project.id);
    const found = await runExtractor(agent, {
      beats: data.beats,
      knownCharacters: data.characters.map((c) => c.name),
      knownLocations: locations.map((l) => l.name),
      previousSummary: previous?.summary ?? null,
      input,
      narration,
    });

    // Newly named characters become provisional records; cards are drafted in Phase 4.
    for (const nc of found.newCharacters) {
      if (ctx.repos.characters.findByName(data.characters, nc.name)) continue;
      data.characters.push(
        await ctx.repos.characters.create({
          projectId: data.project.id,
          name: nc.name,
          tier: nc.proposedTier,
          status: 'provisional',
          firstChapter: data.chapter.number,
        }),
      );
    }
    const characterIds = found.characters
      .map((n) => ctx.repos.characters.findByName(data.characters, n)?.id)
      .filter((id): id is string => !!id);
    const location = found.location
      ? await ctx.repos.characters.ensureLocation(
          data.project.id,
          found.location,
          data.chapter.number,
        )
      : null;

    const event = await ctx.repos.play.addChronicle({
      projectId: data.project.id,
      chapterId: data.chapter.id,
      turnIds: [authorTurn?.id, ...npcTurns.map((t) => t.id), directorTurn.id].filter(
        (id): id is string => !!id,
      ),
      summary: found.summary,
      characters: [...new Set(characterIds)],
      locationId: location?.id ?? previous?.locationId ?? null,
      beatIds: found.beatsHit,
      interiorityNote: interiority?.trim() || null,
      extracted: {
        ...(input?.kind === 'author_note' ? { authorNote: input.text } : {}),
        facts: found.facts,
        promises: found.promises,
        newCharacters: found.newCharacters,
      },
    });
    const hit = new Set([
      ...data.beats.filter((b) => b.source === 'play').map((b) => b.id),
      ...found.beatsHit,
    ]);
    sink.event('chronicle', {
      event,
      beats: beatStatus(data.plan, [...hit], data.chapter.manualBeats),
    });
  } catch (err) {
    // The turn stands even if the chronicle entry could not be made.
    sink.event('warning', {
      message: `This turn was not added to the chronicle: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function withLock<T>(chapterId: string, fn: () => Promise<T>): Promise<T> {
  if (inProgress.has(chapterId))
    throw new ConflictError('A turn is already in progress for this chapter');
  inProgress.add(chapterId);
  try {
    return await fn();
  } finally {
    inProgress.delete(chapterId);
  }
}

function assertWriting(project: Project) {
  if (project.status !== 'writing') throw new ConflictError('The book is not in the writing stage');
}

/** Opens a chapter: the director sets the scene. Chapters are played in order. */
export async function startChapter(ctx: ServiceContext, chapterId: string, sink: PlaySink) {
  return withLock(chapterId, async () => {
    const data = await load(ctx, chapterId);
    assertWriting(data.project);
    const reopening =
      data.chapter.status === 'playing' && !data.turns.some((t) => t.role === 'director');
    if (data.chapter.status !== 'planned' && !reopening) {
      throw new ConflictError('This chapter has already started');
    }
    if (data.chapter.number > 1) {
      const chapters = await ctx.repos.chapters.listForProject(data.project.id);
      const prev = chapters.find((c) => c.number === data.chapter.number - 1);
      if (prev?.status !== 'locked') {
        throw new GateError(
          `Chapter ${data.chapter.number - 1} must be locked before chapter ${data.chapter.number} starts`,
        );
      }
    }
    if (data.chapter.status === 'planned') {
      await ctx.repos.chapters.transition(data.chapter.id, 'planned', 'playing');
    }
    await runTurn(ctx, data, null, null, null, sink);
  });
}

/** Plays one protagonist turn: the input, the director's streamed response, and the chronicle entry. */
export async function submitTurn(
  ctx: ServiceContext,
  chapterId: string,
  input: ProtagonistInput,
  interiority: string | null,
  sink: PlaySink,
) {
  if (!input.text.trim()) throw new GateError('Write something first');
  return withLock(chapterId, async () => {
    const data = await load(ctx, chapterId);
    assertWriting(data.project);
    if (data.chapter.status !== 'playing')
      throw new ConflictError('This chapter is not being played');
    const authorTurn = await ctx.repos.play.addTurn({
      projectId: data.project.id,
      chapterId: data.chapter.id,
      role: 'author',
      inputKind: input.kind,
      content: input.text.trim(),
    });
    sink.event('turn', { author: authorTurn });
    data.turns.push(authorTurn);
    await runTurn(ctx, data, input, authorTurn, interiority, sink);
  });
}

/** Re-runs the director for the last author turn when its response failed. */
export async function retryTurn(ctx: ServiceContext, chapterId: string, sink: PlaySink) {
  return withLock(chapterId, async () => {
    const data = await load(ctx, chapterId);
    assertWriting(data.project);
    const last = data.turns.at(-1);
    if (data.chapter.status !== 'playing')
      throw new ConflictError('This chapter is not being played');
    if (!last) return runTurn(ctx, data, null, null, null, sink);
    if (last.role !== 'author') throw new ConflictError('The last turn already has a response');
    await runTurn(
      ctx,
      data,
      { kind: last.inputKind ?? 'in_character', text: last.content },
      last,
      null,
      sink,
    );
  });
}

export async function getPlayState(ctx: ServiceContext, chapterId: string) {
  const data = await load(ctx, chapterId);
  const [chronicle, scene, promises] = await Promise.all([
    ctx.repos.play.listChronicle(chapterId),
    sceneCharacters(ctx, data),
    plannedPromises(ctx, data.project.id),
  ]);
  return {
    chapter: { id: data.chapter.id, number: data.chapter.number, status: data.chapter.status },
    project: { id: data.project.id, title: data.project.title, status: data.project.status },
    plan: data.plan,
    turns: data.turns.map((t) => ({
      id: t.id,
      seq: t.seq,
      role: t.role,
      inputKind: t.inputKind,
      content: t.content,
    })),
    chronicle,
    beats: data.beats,
    canEnd: data.chapter.status === 'playing' && allBeatsHit(data.beats),
    awaitingResponse: data.turns.at(-1)?.role === 'author',
    sceneCharacters: data.characters
      .filter((c) => scene.ids.includes(c.id))
      .map((c) => ({ id: c.id, name: c.name, tier: c.tier, status: c.status })),
    openPromises: promises.filter(
      (p) => p.plantedChapter <= data.chapter.number && p.payoffChapter >= data.chapter.number,
    ),
  };
}

/** The author marks a beat as hit (or not) by hand; this overrides detection. */
export async function setBeat(
  ctx: ServiceContext,
  chapterId: string,
  beatId: string,
  hit: boolean,
) {
  const data = await load(ctx, chapterId);
  if (!data.plan.requiredBeats.some((b) => b.id === beatId)) throw new NotFoundError('Beat');
  if (data.chapter.status !== 'playing')
    throw new ConflictError('This chapter is not being played');
  const manual = new Set(data.chapter.manualBeats);
  if (hit) manual.add(beatId);
  else manual.delete(beatId);
  await ctx.repos.chapters.setManualBeats(chapterId, [...manual]);
}

/** The author takes a scene out of (or back into) the canon; its beats and facts follow. */
export async function setCanon(
  ctx: ServiceContext,
  chapterId: string,
  eventId: string,
  isCanon: boolean,
) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (chapter?.status !== 'playing') throw new ConflictError('This chapter is not being played');
  await ctx.repos.play.setCanon(chapterId, eventId, isCanon);
}

/** The author confirms the chapter is over. Requires every beat; novelization arrives in Phase 5. */
export async function endChapter(ctx: ServiceContext, chapterId: string) {
  if (inProgress.has(chapterId)) throw new ConflictError('Wait for the current turn to finish');
  const data = await load(ctx, chapterId);
  if (data.chapter.status !== 'playing')
    throw new ConflictError('This chapter is not being played');
  const missing = data.beats.filter((b) => !b.hit);
  if (missing.length) {
    throw new GateError(
      'Every required beat must land before the chapter ends',
      missing.map((b) => `${b.id}: ${b.description}`),
    );
  }
  await ctx.repos.chapters.transition(chapterId, 'playing', 'drafting');
}

/** Returns an ended chapter to play (the review screen's "return to play"). */
export async function reopenChapter(ctx: ServiceContext, chapterId: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  await ctx.repos.chapters.transition(chapterId, 'drafting', 'playing');
}
