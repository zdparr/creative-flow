import { ConflictError, type DriftNotice } from '@storyforge/core';
import {
  sampleOpening,
  sampleOpeningExtraction,
  sampleTurnExtraction,
  sampleTurnNarration,
  seedChapters,
  seedOutline,
} from '@storyforge/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getReview, lockChapter } from './drafting.js';
import { resolveDrift } from './drift.js';
import { getPlayState, startChapter, submitTurn } from './play.js';
import { decideReplanItem, getReplans, unlockChapter } from './replan.js';
import {
  type TestKit,
  createTestKit,
  draftSeedChapter,
  recorder,
  runQueued,
  seededProject,
  waiveAndLock,
  writingProject,
} from './testing.js';

let kit: TestKit;
beforeEach(async () => {
  kit = await createTestKit();
});
afterEach(() => kit.close());

const drift = (notice: Partial<DriftNotice>): DriftNotice => ({
  kind: 'beat',
  description: 'Play moved away from the plan.',
  beatId: null,
  factRef: null,
  character: null,
  adoptText: '',
  ...notice,
});

/** Opens chapter 1 of the sample book and plays a turn whose extraction raises these notices. */
async function playWithDrift(notices: DriftNotice[]) {
  const setup = await writingProject(kit.ctx);
  kit.llm.push(sampleOpening, sampleOpeningExtraction);
  await startChapter(kit.ctx, setup.chapter1.id, recorder().sink);
  kit.llm.push(sampleTurnNarration, { ...sampleTurnExtraction, beatsHit: [], drift: notices });
  const turn = recorder();
  await submitTurn(
    kit.ctx,
    setup.chapter1.id,
    { kind: 'in_character', text: 'I climb to the lamp room instead.' },
    null,
    turn.sink,
  );
  const state = await getPlayState(kit.ctx, setup.chapter1.id);
  return { ...setup, turn, state };
}

describe('Phase 6: drift', () => {
  it('adopting a beat drift updates the outline', async () => {
    const { ctx } = kit;
    const { project, chapter1, turn, state } = await playWithDrift([
      drift({
        beatId: 'c1-b2',
        description: 'Maren found the letter in the lamp room, not on the shore.',
        adoptText: 'She finds the first letter tucked inside the lamp housing.',
      }),
    ]);
    // The notice streamed with the turn and shows inline, unresolved.
    expect(turn.events.map((e) => e.type)).toEqual(['turn', 'turn', 'drift', 'chronicle']);
    expect(state.drift).toMatchObject([{ kind: 'beat', resolution: null }]);
    expect(state.drift[0]!.turnId).toBe(state.turns.at(-1)!.id);

    await resolveDrift(ctx, chapter1.id, state.drift[0]!.id, 'adopt');
    const outline = (await ctx.repos.outlines.latest(project.id))!;
    expect(outline.outline.version).toBe(2);
    expect(outline.chapters[0]!.requiredBeats[1]!.description).toBe(
      'She finds the first letter tucked inside the lamp housing.',
    );
    const after = await getPlayState(ctx, chapter1.id);
    // The chapter now plays from the revised plan, and the adopted beat counts as hit.
    expect(after.plan.requiredBeats[1]!.description).toContain('lamp housing');
    expect(after.beats[1]).toMatchObject({ hit: true, source: 'author' });
    expect(after.drift[0]!.resolution).toBe('adopt');
    await expect(
      resolveDrift(ctx, chapter1.id, state.drift[0]!.id, 'steer'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('steering back tells the director to work the plan in', async () => {
    const { ctx, llm } = kit;
    const { chapter1, state } = await playWithDrift([
      drift({
        kind: 'thread',
        description: 'A smuggling ring appeared.',
        adoptText: 'Who runs the smugglers?',
      }),
    ]);
    await resolveDrift(ctx, chapter1.id, state.drift[0]!.id, 'steer');
    llm.push(sampleTurnNarration, sampleTurnExtraction);
    await submitTurn(
      ctx,
      chapter1.id,
      { kind: 'in_character', text: 'I wait.' },
      null,
      recorder().sink,
    );
    const director = llm.requests.findLast((r) =>
      r.system.includes('director of an interactive novel'),
    )!;
    const message = director.messages[0]!.content as string;
    expect(message).toContain('## Steer back to the plan');
    expect(message).toContain('A smuggling ring appeared.');
  });

  it('adopting a thread opens a promise; a contradiction supersedes the fact', async () => {
    const { ctx } = kit;
    const setup = await writingProject(ctx);
    // A committed fact for the contradiction to point at.
    const fact = await ctx.repos.ledger.add({
      projectId: setup.project.id,
      chapterId: setup.chapter1.id,
      kind: 'object',
      statement: 'The lamp lens is cracked.',
      entities: [],
    });
    kit.llm.push(sampleOpening, sampleOpeningExtraction);
    await startChapter(ctx, setup.chapter1.id, recorder().sink);
    kit.llm.push(sampleTurnNarration, {
      ...sampleTurnExtraction,
      drift: [
        drift({
          kind: 'thread',
          description: 'Smugglers use the rocks.',
          adoptText: 'Who runs the smugglers?',
        }),
        drift({
          kind: 'contradiction',
          factRef: 'F1',
          description: 'The lens is whole in this scene.',
          adoptText: 'The lamp lens was repaired.',
        }),
      ],
    });
    await submitTurn(
      ctx,
      setup.chapter1.id,
      { kind: 'in_character', text: 'I polish the lens.' },
      null,
      recorder().sink,
    );
    const extractor = kit.llm.requests.at(-1)!.messages[0]!.content as string;
    expect(extractor).toContain('F1: The lamp lens is cracked.');

    const state = await getPlayState(ctx, setup.chapter1.id);
    for (const d of state.drift) await resolveDrift(ctx, setup.chapter1.id, d.id, 'adopt');

    const promises = await ctx.repos.promises.list(setup.project.id);
    expect(promises).toMatchObject([
      {
        description: 'Who runs the smugglers?',
        type: 'open_conflict',
        status: 'open',
        window: { from: 2, to: 4 },
      },
    ]);
    const facts = await ctx.repos.ledger.listAll(setup.project.id);
    const repaired = facts.find((f) => f.statement === 'The lamp lens was repaired.')!;
    expect(facts.find((f) => f.id === fact.id)!.supersededBy).toBe(repaired.id);
    expect((await ctx.repos.ledger.listActive(setup.project.id)).map((f) => f.statement)).toEqual([
      'The lamp lens was repaired.',
    ]);
  });
});

describe('Phase 6: re-plan', () => {
  it('proposes outline changes after a lock, which the author accepts or rejects', async () => {
    const { ctx, llm } = kit;
    const { project, chapters } = await seededProject(ctx);
    await draftSeedChapter(kit, chapters[0]!.id, 1);
    await lockChapter(ctx, chapters[0]!.id);

    const ch2 = {
      ...seedOutline.chapters[1]!,
      purpose: 'Tomas arrives, and Maren hides the letters.',
    };
    const ch3 = {
      ...seedOutline.chapters[2]!,
      requiredBeats: [
        ...seedOutline.chapters[2]!.requiredBeats,
        { id: 's3-b2', description: 'Maren shows Tomas the lamp.' },
      ],
    };
    // The first proposal moves an anchor, so it is sent back once.
    await runQueued(
      kit,
      'outline.replan',
      {
        changes: [
          { chapter: 2, reason: 'x', after: { ...ch2, isAnchor: false, anchorType: null } },
        ],
      },
      {
        changes: [
          { chapter: 2, reason: 'The letters are now a secret.', after: ch2 },
          { chapter: 3, reason: 'Tomas has not seen the lamp lit.', after: ch3 },
        ],
      },
    );
    const retry = llm.requests.at(-1)!.messages.at(-1)!.content as string;
    expect(retry).toContain('anchor beats never move');
    const replanPrompt = llm.requests.at(-1)!.messages[0]!.content as string;
    expect(replanPrompt).toContain('letter to her dead sister');

    const { diffs } = await getReplans(ctx, project.id);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.items.map((i) => [i.chapter, i.decision])).toEqual([
      [2, null],
      [3, null],
    ]);

    await decideReplanItem(ctx, project.id, diffs[0]!.id, 'i1', 'accept');
    await decideReplanItem(ctx, project.id, diffs[0]!.id, 'i2', 'reject');
    const outline = (await ctx.repos.outlines.latest(project.id))!;
    expect(outline.outline.version).toBe(2);
    expect(outline.chapters[1]!.purpose).toBe(ch2.purpose);
    expect(outline.chapters[2]!.requiredBeats).toHaveLength(1);
    // The live chapter now reads its plan from the new version.
    const plan = await ctx.repos.chapters.plan((await ctx.repos.chapters.get(chapters[1]!.id))!);
    expect(plan!.purpose).toBe(ch2.purpose);
    expect((await getReplans(ctx, project.id)).diffs).toEqual([]);
  });
});

describe('Phase 6: unlock', () => {
  it('unlocking chapter 2 flags chapter 3 and re-runs its cohesion check', async () => {
    const { ctx } = kit;
    const { project, chapters } = await seededProject(ctx);
    for (const n of [1, 2, 3] as const) {
      await draftSeedChapter(kit, chapters[n - 1]!.id, n);
      await waiveAndLock(kit, chapters[n - 1]!.id);
    }
    const factsBefore = (await ctx.repos.ledger.listAll(project.id)).length;

    const { flagged } = await unlockChapter(ctx, chapters[1]!.id);
    expect(flagged).toEqual([3]);
    const statuses = (await ctx.repos.chapters.listForProject(project.id)).map((c) => c.status);
    expect(statuses).toEqual(['locked', 'review', 'needs_recheck']);
    // Unlocking restores nothing: the ledger is untouched.
    expect(await ctx.repos.ledger.listAll(project.id)).toHaveLength(factsBefore);
    await expect(unlockChapter(ctx, chapters[1]!.id)).rejects.toBeInstanceOf(ConflictError);

    // Chapter 3's check re-runs against the current state; it stays flagged until confirmed.
    await runQueued(kit, 'chapter.cohesion', seedChapters[3].critic);
    let review3 = await getReview(ctx, chapters[2]!.id);
    expect(review3.chapter.status).toBe('needs_recheck');
    expect(review3.report?.current).toBe(true);
    // Waivers for issues the re-check finds again carry over.
    expect(review3.report?.waived.map((w) => w.reason)).toContain('Accepted for the test book');
    expect(review3.gates.openBlockers).toBe(0);

    // Re-locking chapter 2 does not duplicate its facts; then chapter 3 is confirmed.
    await waiveAndLock(kit, chapters[1]!.id);
    expect(await ctx.repos.ledger.listAll(project.id)).toHaveLength(factsBefore);
    await waiveAndLock(kit, chapters[2]!.id);
    review3 = await getReview(ctx, chapters[2]!.id);
    expect(review3.chapter.status).toBe('locked');
  });
});
