import { GateError, normalizeCard } from '@storyforge/core';
import {
  sampleAdaCard,
  sampleBible,
  sampleMajorCard,
  sampleMinorCharacterExtraction,
  sampleOpening,
  sampleOpeningExtraction,
  sampleTurnNarration,
} from '@storyforge/core/testing';
import { cardsAsOf } from '@storyforge/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DraftCardJobInput,
  approveCharacter,
  draftCard,
  editCharacter,
  ensureCast,
  getCharacter,
  listCharacters,
  mergeCharacter,
  rejectCharacter,
  unapprovedCharactersIn,
} from './characters.js';
import { getPlayState, startChapter, submitTurn } from './play.js';
import { type TestKit, createTestKit, recorder, writingProject } from './testing.js';

let kit: TestKit;
beforeEach(async () => {
  kit = await createTestKit();
});
afterEach(() => kit.close());

/** Plays the opening and one turn that introduces Ada Fenn (a minor character). */
async function introduceAda() {
  const { ctx, llm } = kit;
  const setup = await writingProject(ctx);
  llm.push(
    sampleOpening,
    sampleOpeningExtraction,
    sampleTurnNarration,
    sampleMinorCharacterExtraction,
  );
  await startChapter(ctx, setup.chapter1.id, recorder().sink);
  await submitTurn(
    ctx,
    setup.chapter1.id,
    { kind: 'in_character', text: 'I go down to meet the post boat.' },
    null,
    recorder().sink,
  );
  const characters = await ctx.repos.characters.list(setup.project.id);
  const ada = characters.find((c) => c.name === 'Ada Fenn')!;
  return { ...setup, ada };
}

/** Runs the newest queued card-draft job with a scripted drafter response. */
async function runQueuedDraft(response: unknown) {
  const job = kit.queued.findLast((j) => j.type === 'character.draftCard')!;
  kit.llm.push(response);
  return draftCard(kit.ctx, job.id, job.data as unknown as DraftCardJobInput);
}

const reload = async (id: string) => (await kit.ctx.repos.characters.get(id))!;

describe('Phase 4: characters', () => {
  it('drafts a card for a character introduced in play, which the author approves at scene end', async () => {
    const { ctx } = kit;
    const { project, chapter1, ada } = await introduceAda();

    // Detected as provisional, usable in play, with a draft job queued.
    expect(ada).toMatchObject({ tier: 'minor', status: 'provisional', firstChapter: 1 });
    expect(kit.queued.map((j) => j.type)).toEqual(['character.draftCard']);

    await runQueuedDraft(sampleAdaCard);
    const view = await getCharacter(ctx, ada);
    expect(view.pendingVersion?.card.storyRole).toContain('first warning');
    expect(view.pendingVersion?.source).toBe('drafted');
    expect(view.missing).toEqual([]);
    expect(view.needsApproval).toBe(true);

    // The tray surfaces it between turns, and the lock gate sees it.
    const state = await getPlayState(ctx, chapter1.id);
    expect(state.cardTray.map((c) => c.name)).toEqual(['Ada Fenn']);
    const blocking = await unapprovedCharactersIn(ctx, project.id, chapter1.id);
    expect(blocking.map((c) => c.name)).toEqual(['Ada Fenn']);

    // The author edits one field while approving.
    await approveCharacter(ctx, ada, { ...sampleAdaCard, trait: 'kind gossip' });
    const approved = await getCharacter(ctx, await reload(ada.id));
    expect(approved.status).toBe('approved');
    expect(approved.pendingVersion).toBeNull();
    expect(approved.approvedVersion?.card.trait).toBe('kind gossip');
    expect(await unapprovedCharactersIn(ctx, project.id, chapter1.id)).toEqual([]);
    const tray = (await getPlayState(ctx, chapter1.id)).cardTray;
    expect(tray.filter((c) => c.needsApproval)).toEqual([]);

    // The drafter ran as its own logged agent call.
    const calls = await ctx.repos.llmCalls.listForProject(project.id);
    expect(calls.map((c) => c.agent)).toContain('card_drafter');
  });

  it('enforces required fields for the tier before approval', async () => {
    const { ada } = await introduceAda();
    const attempt = approveCharacter(kit.ctx, ada, { ...sampleAdaCard, want: '', voiceNote: ' ' });
    await expect(attempt).rejects.toBeInstanceOf(GateError);
    await expect(attempt).rejects.toMatchObject({
      problems: ['want is empty', 'voiceNote is empty'],
    });
  });

  it('retries a drafted card that is missing required fields', async () => {
    await introduceAda();
    const job = kit.queued[0]!;
    kit.llm.push({ ...sampleAdaCard, want: '' }, sampleAdaCard);
    await draftCard(kit.ctx, job.id, job.data as unknown as DraftCardJobInput);
    const retry = kit.llm.requests.at(-1)!.messages.at(-1)!.content as string;
    expect(retry).toContain('want: required for a minor card');
  });

  it('merges a duplicate into an existing character', async () => {
    const { ctx } = kit;
    const { project, chapter1, ada } = await introduceAda();
    const characters = await ctx.repos.characters.list(project.id);
    const maren = characters.find((c) => c.name === 'Maren Tull')!;
    const merged = await mergeCharacter(ctx, ada, maren.id);
    expect(merged.aliases).toContain('Ada Fenn');
    expect(await ctx.repos.characters.get(ada.id)).toBeNull();
    const chronicle = await ctx.repos.play.listChronicle(chapter1.id);
    expect(chronicle[1]!.characters).toEqual([maren.id]);
  });

  it('rejects a provisional character, removing it from the chronicle', async () => {
    const { ctx } = kit;
    const { project, chapter1, ada } = await introduceAda();
    await rejectCharacter(ctx, ada);
    const names = (await ctx.repos.characters.list(project.id)).map((c) => c.name);
    expect(names).not.toContain('Ada Fenn');
    const chronicle = await ctx.repos.play.listChronicle(chapter1.id);
    expect(chronicle[1]!.characters).toHaveLength(1);
  });

  it('suggests promotion and drafts only the missing fields', async () => {
    const { ctx } = kit;
    const { project, ada } = await introduceAda();
    await runQueuedDraft(sampleAdaCard);
    await approveCharacter(ctx, ada);

    // Ada took part in a scene that hit a required beat, so the tray suggests promotion.
    const view = (await listCharacters(ctx, project.id)).find((c) => c.id === ada.id)!;
    expect(view.promotion).toEqual({ to: 'major', reasons: ['takes part in a required beat'] });

    await editCharacter(ctx, await reload(ada.id), { tier: 'major' });
    expect(kit.queued.at(-1)!.data).toMatchObject({ tier: 'major' });
    await runQueuedDraft({ ...sampleMajorCard, storyRole: 'CHANGED', principles: ['Never lies'] });

    const promoted = await getCharacter(ctx, await reload(ada.id));
    expect(promoted.tier).toBe('major');
    // Filled fields are kept exactly; only the missing major fields come from the draft.
    expect(promoted.pendingVersion?.card.storyRole).toBe(sampleAdaCard.storyRole);
    expect(promoted.pendingVersion?.card.principles).toEqual(['Never lies']);
    expect(promoted.needsApproval).toBe(true);
    const prompt = kit.llm.requests.at(-1)!.messages[0]!.content as string;
    expect(prompt).toContain('Existing card');
  });

  it('backfills cards for characters created before cards were versioned', async () => {
    const { ctx } = kit;
    const { project } = await writingProject(ctx);
    // As Phase 3 left them: records with no card versions.
    const make = (
      name: string,
      tier: 'major' | 'minor' | 'walk_on',
      status: 'approved' | 'provisional',
    ) =>
      ctx.repos.characters.create({ projectId: project.id, name, tier, status, firstChapter: 1 });
    await make('Maren Tull', 'major', 'approved');
    await make('Old Hendry', 'walk_on', 'provisional');
    const ada = await make('Ada Fenn', 'minor', 'provisional');

    await ensureCast(ctx, project.id, sampleBible);

    const after = await listCharacters(ctx, project.id);
    const byName = (n: string) => after.find((c) => c.name === n)!;
    expect(byName('Maren Tull').approvedVersion?.card.want).toBe(sampleBible.world.cast[0]!.want);
    expect(byName('Old Hendry')).toMatchObject({ status: 'approved', needsApproval: false });
    expect(byName('Ada Fenn')).toMatchObject({ status: 'provisional', needsApproval: true });
    expect(kit.queued.map((j) => j.data)).toEqual([
      expect.objectContaining({ characterId: ada.id }),
    ]);

    // It runs once: a second pass adds nothing.
    await ensureCast(ctx, project.id, sampleBible);
    expect(kit.queued).toHaveLength(1);
  });

  it('versions cards by the chapter they take effect in', async () => {
    const { ctx } = kit;
    const { project, chapter1, ada } = await introduceAda();
    await runQueuedDraft(sampleAdaCard);
    await approveCharacter(ctx, ada);

    // Once chapter 1 is locked, an author edit takes effect from chapter 2.
    await ctx.repos.chapters.transition(chapter1.id, 'playing', 'drafting');
    await ctx.repos.chapters.transition(chapter1.id, 'drafting', 'review');
    await ctx.repos.chapters.transition(chapter1.id, 'review', 'locked');
    await editCharacter(ctx, await reload(ada.id), {
      card: { ...sampleAdaCard, want: 'To leave Harrow at last.' },
    });

    const versions = await ctx.repos.characters.listVersionsForProject(project.id);
    const want = (chapter: number) =>
      normalizeCard(cardsAsOf(versions, chapter).get(ada.id)!.card).want;
    expect(want(1)).toBe(sampleAdaCard.want);
    expect(want(2)).toBe('To leave Harrow at last.');
  });
});
