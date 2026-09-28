import { ConflictError, GateError } from '@storyforge/core';
import {
  FakeLlm,
  sampleBible,
  sampleNpcVoice,
  sampleOpening,
  sampleOpeningExtraction,
  sampleOutline,
  samplePitch,
  sampleTurnExtraction,
  sampleTurnNarration,
} from '@storyforge/core/testing';
import { createRepos } from '@storyforge/db';
import { createTestDb } from '@storyforge/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ServiceContext, createServiceContext } from './context.js';
import {
  type PlaySink,
  endChapter,
  getPlayState,
  retryTurn,
  setBeat,
  setCanon,
  startChapter,
  submitTurn,
} from './play.js';

let close: () => Promise<void>;
let ctx: ServiceContext;
let llm: FakeLlm;

beforeEach(async () => {
  const test = await createTestDb();
  close = test.close;
  llm = new FakeLlm();
  ctx = createServiceContext({ db: test.db, llm, enqueue: async () => {} });
});
afterEach(() => close());

/** A project with an approved bible and outline, ready to play. */
async function writingProject() {
  const repos = createRepos(ctx.db);
  const user = await repos.users.findOrCreateByEmail('author@example.com');
  const project = await repos.projects.create(user.id, samplePitch, sampleBible.title);
  const bible = await repos.bibles.createVersion(project.id, {
    spine: sampleBible.spine,
    world: sampleBible.world,
    styleGuide: sampleBible.styleGuide,
  });
  await repos.bibles.markApproved(bible.id);
  const outline = await repos.outlines.createVersion(project.id, sampleOutline.chapters);
  await repos.outlines.markApproved(outline.outline.id);
  await repos.outlines.createChapters(project.id, outline);
  await repos.projects.transition(project.id, 'intake', 'bible_review');
  await repos.projects.transition(project.id, 'bible_review', 'outline_review');
  await repos.projects.transition(project.id, 'outline_review', 'writing');
  const chapters = await repos.chapters.listForProject(project.id);
  return { project, chapter1: chapters[0]!, chapter2: chapters[1]! };
}

function recorder() {
  const events: { type: string; data: unknown }[] = [];
  let text = '';
  const npcs: string[] = [];
  const sink: PlaySink = {
    text: (d) => void (text += d),
    npc: (n) => void npcs.push(n),
    event: (type, data) => void events.push({ type, data }),
  };
  return { sink, events, npcs, text: () => text };
}

describe('Phase 3: play a chapter', () => {
  it('plays a full chapter and ends it, with a chronicle recorded', async () => {
    const { chapter1 } = await writingProject();

    // Opening: the director streams the scene, the extractor records it.
    llm.push(sampleOpening, sampleOpeningExtraction);
    const opening = recorder();
    await startChapter(ctx, chapter1.id, opening.sink);
    expect(opening.text()).toContain('hundred and twelve stairs');
    expect(opening.events.map((e) => e.type)).toEqual(['turn', 'chronicle']);

    let state = await getPlayState(ctx, chapter1.id);
    expect(state.chapter.status).toBe('playing');
    expect(state.beats.map((b) => b.hit)).toEqual([true, false]);
    expect(state.canEnd).toBe(false);
    await expect(endChapter(ctx, chapter1.id)).rejects.toBeInstanceOf(GateError);

    // A protagonist turn with an interiority note.
    llm.push(sampleTurnNarration, sampleTurnExtraction);
    const turn = recorder();
    await submitTurn(
      ctx,
      chapter1.id,
      { kind: 'in_character', text: 'I walk down to the tideline.' },
      'She is afraid of hoping.',
      turn.sink,
    );
    expect(turn.events.map((e) => e.type)).toEqual(['turn', 'turn', 'chronicle']);

    state = await getPlayState(ctx, chapter1.id);
    expect(state.turns.map((t) => t.role)).toEqual(['director', 'author', 'director']);
    expect(state.canEnd).toBe(true);
    expect(state.chronicle).toHaveLength(2);
    const event = state.chronicle[1]!;
    expect(event.summary).toContain('bottle');
    expect(event.interiorityNote).toBe('She is afraid of hoping.');
    expect(event.turnIds).toHaveLength(2);
    // Candidate facts and promises stay pending on the event until lock.
    expect(event.extracted.facts[0]!.statement).toContain('first bottle');
    expect(event.extracted.promises).toHaveLength(1);

    // A newly named walk-on gets an approved card at once; the location is created once.
    const characters = await ctx.repos.characters.list(state.project.id);
    expect(characters.find((c) => c.name === 'Old Hendry')).toMatchObject({
      status: 'approved',
      tier: 'walk_on',
      firstChapter: 1,
    });
    expect(await ctx.repos.characters.listLocations(state.project.id)).toHaveLength(1);

    await endChapter(ctx, chapter1.id);
    expect((await getPlayState(ctx, chapter1.id)).chapter.status).toBe('drafting');

    // Every agent call was logged against the project.
    const calls = await ctx.repos.llmCalls.listForProject(state.project.id);
    expect(calls.map((c) => c.agent)).toEqual(['director', 'extractor', 'director', 'extractor']);
  });

  it('records author notes on the chronicle so later stages know the author chose it', async () => {
    const { chapter1 } = await writingProject();
    llm.push(sampleOpening, sampleOpeningExtraction, sampleTurnNarration, sampleTurnExtraction);
    await startChapter(ctx, chapter1.id, recorder().sink);
    await submitTurn(
      ctx,
      chapter1.id,
      { kind: 'author_note', text: 'Make it storm.' },
      null,
      recorder().sink,
    );
    const state = await getPlayState(ctx, chapter1.id);
    expect(state.turns[1]).toMatchObject({ role: 'author', inputKind: 'author_note' });
    expect(state.chronicle[1]!.extracted.authorNote).toBe('Make it storm.');
    const directorPrompt = llm.requests[2]!.messages[0]!.content as string;
    expect(directorPrompt).toContain('[author: Make it storm.]');
  });

  it('voices major characters through the NPC agent', async () => {
    const { chapter1 } = await writingProject();
    llm.push(sampleOpening, sampleOpeningExtraction);
    await startChapter(ctx, chapter1.id, recorder().sink);

    llm.push(
      {
        toolCalls: [
          {
            name: 'voice_character',
            input: { character: 'Tomas Reyne', situation: 'Maren refuses.' },
          },
        ],
        stream: ['Tomas set his clipboard on the rail.'],
      },
      sampleNpcVoice,
      sampleTurnExtraction,
    );
    const turn = recorder();
    await submitTurn(
      ctx,
      chapter1.id,
      { kind: 'in_character', text: 'I refuse to leave.' },
      null,
      turn.sink,
    );
    expect(turn.npcs).toEqual(['Tomas Reyne']);
    expect(JSON.parse(llm.toolResults[0]!)).toEqual(sampleNpcVoice);

    const state = await getPlayState(ctx, chapter1.id);
    expect(state.turns.map((t) => t.role)).toEqual(['director', 'author', 'npc', 'director']);
    expect(state.chronicle[1]!.turnIds).toHaveLength(3);
    // The NPC agent saw only its own card, never the protagonist's.
    const npcPrompt = llm.requests[3]!.messages[0]!.content as string;
    expect(npcPrompt).toContain('You are Tomas Reyne');
    expect(npcPrompt).not.toContain('Believes duty can hold back grief');
  });

  it('refuses to voice the protagonist through the NPC agent', async () => {
    const { chapter1 } = await writingProject();
    llm.push(sampleOpening, sampleOpeningExtraction);
    await startChapter(ctx, chapter1.id, recorder().sink);
    llm.push(
      {
        toolCalls: [
          { name: 'voice_character', input: { character: 'Maren Tull', situation: 'x' } },
        ],
        stream: ['...'],
      },
      sampleTurnExtraction,
    );
    await submitTurn(
      ctx,
      chapter1.id,
      { kind: 'in_character', text: 'I wait.' },
      null,
      recorder().sink,
    );
    expect(llm.toolResults[0]).toContain('Voice them yourself');
  });

  it('lets the author override a missed beat, and un-canon a scene', async () => {
    const { chapter1 } = await writingProject();
    llm.push(sampleOpening, sampleOpeningExtraction);
    await startChapter(ctx, chapter1.id, recorder().sink);

    await setBeat(ctx, chapter1.id, 'c1-b2', true);
    let state = await getPlayState(ctx, chapter1.id);
    expect(state.beats[1]).toMatchObject({ hit: true, source: 'author' });
    expect(state.canEnd).toBe(true);

    // Taking the opening out of canon removes the beat it hit.
    await setCanon(ctx, chapter1.id, state.chronicle[0]!.id, false);
    state = await getPlayState(ctx, chapter1.id);
    expect(state.beats[0]!.hit).toBe(false);
    expect(state.canEnd).toBe(false);
  });

  it('keeps the turn when the extractor fails, and warns', async () => {
    const { chapter1 } = await writingProject();
    llm.push(sampleOpening, 'not json', 'still not json');
    const opening = recorder();
    await startChapter(ctx, chapter1.id, opening.sink);
    expect(opening.events.map((e) => e.type)).toEqual(['turn', 'warning']);
    const state = await getPlayState(ctx, chapter1.id);
    expect(state.turns).toHaveLength(1);
    expect(state.chronicle).toHaveLength(0);
  });

  it('retries the director after a failed response', async () => {
    const { chapter1 } = await writingProject();
    llm.push(sampleOpening, sampleOpeningExtraction);
    await startChapter(ctx, chapter1.id, recorder().sink);
    // The director call fails (no scripted response), leaving the author turn unanswered.
    await expect(
      submitTurn(ctx, chapter1.id, { kind: 'in_character', text: 'I run.' }, null, recorder().sink),
    ).rejects.toThrow();
    expect((await getPlayState(ctx, chapter1.id)).awaitingResponse).toBe(true);

    llm.push(sampleTurnNarration, sampleTurnExtraction);
    await retryTurn(ctx, chapter1.id, recorder().sink);
    const state = await getPlayState(ctx, chapter1.id);
    expect(state.awaitingResponse).toBe(false);
    expect(state.turns.map((t) => t.role)).toEqual(['director', 'author', 'director']);
  });

  it('plays chapters in order and one turn at a time', async () => {
    const { chapter1, chapter2 } = await writingProject();
    await expect(startChapter(ctx, chapter2.id, recorder().sink)).rejects.toBeInstanceOf(GateError);

    llm.push(sampleOpening, sampleOpeningExtraction, sampleTurnNarration, sampleTurnExtraction);
    await startChapter(ctx, chapter1.id, recorder().sink);
    const first = submitTurn(
      ctx,
      chapter1.id,
      { kind: 'in_character', text: 'a' },
      null,
      recorder().sink,
    );
    await expect(
      submitTurn(ctx, chapter1.id, { kind: 'in_character', text: 'b' }, null, recorder().sink),
    ).rejects.toBeInstanceOf(ConflictError);
    await first;
  });

  it('builds the director context within the spec rules', async () => {
    const { chapter1 } = await writingProject();
    llm.push(sampleOpening, sampleOpeningExtraction);
    await startChapter(ctx, chapter1.id, recorder().sink);
    const request = llm.requests[0]!;
    // Stable prefix in the system prompt, the chapter plan and beats in the message.
    expect(request.system).toContain(sampleBible.spine.centralQuestion);
    const message = request.messages[0]!.content as string;
    expect(message).toContain(sampleOutline.chapters[0]!.purpose);
    expect(message).toContain('[ ] c1-b1');
    expect(message).toContain('Open the chapter');
    expect(message).toContain('Who is writing the letters?');
  });
});
