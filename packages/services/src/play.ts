import {
  type BeatStatus,
  type BibleContent,
  ConflictError,
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
import { cardsForChapter, ensureCast, listCharacters, registerNewCharacter } from './characters.js';
import type { ServiceContext } from './context.js';
import { requestNovelize } from './drafting.js';
import { recordDrift } from './drift.js';
import { knowledgeItems, ledgerFacts, promisesForPlay, toPlan } from './state.js';

/** Receives a turn as it happens; the API forwards these as server-sent events. */
export interface PlaySink {
  text(delta: string): void;
  npc(name: string): void;
  event(type: 'turn' | 'chronicle' | 'warning' | 'drift', data: unknown): void;
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
  const agent = ctx.agentContext(data.project.id, { chapterId: data.chapter.id });
  const scene = await sceneCharacters(ctx, data);
  const cards = await cardsForChapter(ctx, data.project.id, data.characters, data.chapter.number);
  const cardOf = (id: string) => cards.find((c) => c.id === id)!;
  const [facts, knowledge, drift] = await Promise.all([
    ledgerFacts(ctx, data.project.id),
    knowledgeItems(ctx, data.project.id),
    ctx.repos.drift.listForChapter(data.chapter.id),
  ]);
  // Drift the author chose to steer back: the director works the plan back in.
  const steered = drift.filter((d) => d.resolution === 'steer');
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
      characters: cards,
      sceneCharacterIds: scene.ids,
      sceneLocationId: scene.locationId,
      turns: data.turns.map(toContextTurn),
      lockedSummaries,
      facts,
      promises: await promisesForPlay(ctx, data.project.id, data.chapter.number),
      steer: steered.map((d) => d.description),
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
          character: cardOf(character.id),
          knowledge,
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
    // Recent facts get short refs so a contradiction notice can point at one.
    const factRefs = new Map(facts.slice(-40).map((f, i) => [`F${i + 1}`, f.id]));
    const statements = new Map(facts.map((f) => [f.id, f.statement]));
    const found = await runExtractor(agent, {
      facts: [...factRefs].map(([ref, id]) => ({ ref, statement: statements.get(id)! })),
      principles: cards
        .filter((c) => c.tier === 'major' && (c.card.principles ?? []).length > 0)
        .map((c) => ({ character: c.name, principles: c.card.principles ?? [] })),
      beats: data.beats,
      knownCharacters: data.characters.map((c) => c.name),
      knownLocations: locations.map((l) => l.name),
      previousSummary: previous?.summary ?? null,
      input,
      narration,
    });

    // Newly named characters: walk-ons get a card at once; others get a drafted card to approve.
    for (const nc of found.newCharacters) {
      if (ctx.repos.characters.findByName(data.characters, nc.name)) continue;
      data.characters.push(
        await registerNewCharacter(ctx, data.project.id, data.chapter.number, nc, found.location),
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
    const notices = await recordDrift(
      ctx,
      { projectId: data.project.id, chapterId: data.chapter.id, turnId: directorTurn.id },
      found.drift,
      factRefs,
    );
    if (notices.length) sink.event('drift', { notices });
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
  const [chronicle, scene, promises, characters, drift] = await Promise.all([
    ctx.repos.play.listChronicle(chapterId),
    sceneCharacters(ctx, data),
    promisesForPlay(ctx, data.project.id, data.chapter.number),
    listCharacters(ctx, data.project.id),
    ctx.repos.drift.listForChapter(chapterId),
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
    // The card tray: drafts to approve and promotions to consider, shown between turns.
    cardTray: characters.filter((c) => c.needsApproval || c.promotion),
    // Drift notices, shown inline after the turn that raised them.
    drift: drift.map((d) => ({
      id: d.id,
      turnId: d.turnId,
      kind: d.kind,
      description: d.description,
      adoptText: d.details.adoptText,
      resolution: d.resolution,
    })),
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
  await requestNovelize(ctx, data.chapter);
}

/**
 * Returns an ended chapter to play (the review screen's "return to play"). Not while a draft
 * is being written, so a finishing job cannot move the chapter on underneath the author.
 */
export async function reopenChapter(ctx: ServiceContext, chapterId: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  if (chapter.status !== 'drafting' && chapter.status !== 'review') {
    throw new ConflictError('Only a chapter in drafting or review can return to play');
  }
  const job = await ctx.repos.jobs.latestForChapter(chapterId, [
    'chapter.novelize',
    'chapter.cohesion',
  ]);
  if (job && (job.status === 'queued' || job.status === 'running')) {
    throw new ConflictError('Wait for the draft to finish, then return to play from review');
  }
  await ctx.repos.chapters.transition(chapterId, chapter.status, 'playing');
}
