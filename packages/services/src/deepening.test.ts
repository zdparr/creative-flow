import { ConflictError, type ExtractorOutput, draftParagraphs } from '@storyforge/core';
import { sampleReplan, seedChapters } from '@storyforge/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { editDraft, getReview, lockChapter, requestDeepen } from './drafting.js';
import { endChapter, startChapter } from './play.js';
import { unlockChapter } from './replan.js';
import {
  type TestKit,
  createTestKit,
  draftSeedChapter,
  recorder,
  runQueued,
  seededProject,
  waiveAndLock,
} from './testing.js';

let kit: TestKit;
afterEach(() => kit.close());

const promised = 'Maren keeps the letters from the harbor authority.';
const unrelated = 'Old Hendry keeps the ferry schedule from Ada Fenn.';

const extraction: ExtractorOutput = {
  ...seedChapters[1].extraction,
  commitments: [
    {
      kind: 'promise',
      from: 'Maren Tull',
      to: ['Tomas Reyne'],
      content: promised,
      scope: 'the harbor authority',
      words: 'Not a word of them leaves this island.',
    },
    {
      kind: 'secret',
      from: 'Old Hendry',
      to: ['Ada Fenn'],
      content: unrelated,
      scope: '',
      words: '',
    },
  ],
};

/** A deepening pass that adds one italic thought to the second paragraph. */
const deepened = {
  pivotalMoments: [{ paragraph: 2, moment: 'the letter' }],
  edits: [
    { paragraph: 2, text: `${draftParagraphs(seedChapters[1].prose)[1]} *Isla,* she thought.` },
  ],
  inserts: [],
};

const requestFor = (marker: string) => kit.llm.requests.findLast((r) => r.system.includes(marker))!;
const userText = (marker: string) => requestFor(marker).messages[0]!.content as string;

async function playChapter1(chapterId: string) {
  kit.llm.push(seedChapters[1].opening, extraction);
  await startChapter(kit.ctx, chapterId, recorder().sink);
  await endChapter(kit.ctx, chapterId);
}

describe('deepening pass and commitments ledger', () => {
  it('carries commitments from play through prose, the check, and the lock into the next chapter', async () => {
    kit = await createTestKit({ deepen: true });
    const { ctx } = kit;
    const { project, chapters, tomas } = await seededProject(ctx);
    const [c1, c2] = chapters as [(typeof chapters)[0], (typeof chapters)[0]];
    await playChapter1(c1.id);

    // The novelize job writes the draft, then the deepened version on top of it.
    await runQueued(kit, 'chapter.novelize', seedChapters[1].prose, deepened);
    const versions = await ctx.repos.drafts.list(c1.id);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    const current = await ctx.repos.drafts.current(c1.id);
    expect(current!.prose).toContain('*Isla,* she thought.');
    expect(current!.notes).toMatch(/^Deepening pass \(\+\d+%\)$/);
    // The check runs on the deepened version.
    expect(kit.queued.find((j) => j.type === 'chapter.cohesion')!.data.draftId).toBe(current!.id);

    // Both prose agents see this chapter's commitments and the threads to close on.
    expect(userText('novelizer in Story Forge')).toContain(promised);
    const deepener = userText('deepening editor');
    expect(deepener).toContain(promised);
    expect(deepener).toContain('- Who is writing the letters?');

    // The critic gets them with refs and reports which the draft tested.
    await runQueued(kit, 'chapter.cohesion', {
      ...seedChapters[1].critic,
      commitmentsTested: [{ ref: 'C1', outcome: 'kept' }],
    });
    expect(userText('cohesion critic')).toContain(
      `C1: Maren Tull to Tomas Reyne (promise, chapter 1): ${promised}`,
    );
    expect((await getReview(ctx, c1.id)).canLock).toBe(true);

    // The lock commits them, with the test recorded; a re-lock would not add them twice.
    await lockChapter(ctx, c1.id);
    await runQueued(kit, 'outline.replan', sampleReplan);
    const ledger = await ctx.repos.commitments.list(project.id);
    expect(ledger).toMatchObject([
      {
        content: promised,
        giver: 'Maren Tull',
        recipients: ['Tomas Reyne'],
        status: 'active',
        testedChapters: [1],
      },
      { content: unrelated, testedChapters: [] },
    ]);
    expect(ledger[0]!.entities).toContain(tomas.id);

    // Planning agents never see the ledger.
    expect(userText('re-planner')).not.toContain(promised);

    // Chapter 2's director gets the commitment between characters in the scene, and only that.
    kit.llm.push(seedChapters[2].opening, seedChapters[2].extraction);
    await startChapter(ctx, c2.id, recorder().sink);
    const director = userText('director of an interactive novel');
    expect(director).toContain('## Secrets and instructions in force');
    expect(director).toContain(
      `${promised} Scope: the harbor authority. As said: "Not a word of them leaves this island." Tested in chapter 1.`,
    );
    expect(director).not.toContain(unrelated);
  });

  it('keeps the undeepened draft when the pass keeps rewriting it', async () => {
    kit = await createTestKit({ deepen: true });
    const { chapters } = await seededProject(kit.ctx);
    await playChapter1(chapters[0]!.id);

    const rewrite = {
      pivotalMoments: [],
      edits: [{ paragraph: 1, text: 'Something else entirely.' }],
      inserts: [],
    };
    await runQueued(kit, 'chapter.novelize', seedChapters[1].prose, rewrite, rewrite);
    const versions = await kit.ctx.repos.drafts.list(chapters[0]!.id);
    expect(versions).toHaveLength(1);
    const current = await kit.ctx.repos.drafts.current(chapters[0]!.id);
    expect(current!.prose).toBe(seedChapters[1].prose);
    expect(kit.queued.find((j) => j.type === 'chapter.cohesion')!.data.draftId).toBe(current!.id);
  });

  it('deepens chapters written before the pass, with what an author edit to an earlier one added', async () => {
    kit = await createTestKit();
    const { ctx } = kit;
    const { project, chapters } = await seededProject(ctx);
    const [c1, c2] = chapters as [(typeof chapters)[0], (typeof chapters)[0]];
    for (const n of [1, 2] as const) {
      await draftSeedChapter(kit, chapters[n - 1]!.id, n);
      await waiveAndLock(kit, chapters[n - 1]!.id);
    }
    // A locked chapter cannot be deepened in place.
    await expect(requestDeepen(ctx, c2.id)).rejects.toBeInstanceOf(ConflictError);

    // The author unlocks chapter 1 and edits in an order play never recorded.
    await unlockChapter(ctx, c1.id);
    // Unlocking queues chapter 2's recheck first.
    await runQueued(kit, 'chapter.cohesion', seedChapters[2].critic);
    const order = 'Maren tells no one in Harrow about the letters.';
    await editDraft(
      ctx,
      c1.id,
      `${seedChapters[1].prose}

"Tell no one in Harrow," Tomas had written. Not a word.`,
    );
    await runQueued(kit, 'chapter.cohesion', {
      ...seedChapters[1].critic,
      commitmentsGiven: [
        {
          kind: 'instruction',
          from: 'Tomas Reyne',
          to: ['Maren Tull'],
          content: order,
          scope: 'no one in Harrow',
          words: 'Tell no one in Harrow.',
          testedHere: false,
        },
      ],
    });
    await waiveAndLock(kit, c1.id);
    expect(await ctx.repos.commitments.list(project.id)).toMatchObject([
      { content: order, giver: 'Tomas Reyne', status: 'active' },
    ]);

    // Chapter 2 was flagged; once its recheck is in, the author deepens it.
    expect((await getReview(ctx, c2.id)).chapter.status).toBe('needs_recheck');
    await requestDeepen(ctx, c2.id);
    await expect(requestDeepen(ctx, c2.id)).rejects.toBeInstanceOf(ConflictError);
    expect((await getReview(ctx, c2.id)).job).toMatchObject({ stage: 'Deepening prose' });

    const before = draftParagraphs(seedChapters[2].prose);
    await runQueued(kit, 'chapter.deepen', {
      pivotalMoments: [{ paragraph: 2, moment: 'the order' }],
      edits: [{ paragraph: 2, text: `${before[1]} *Tell no one,* she remembered.` }],
      inserts: [],
    });
    expect(userText('deepening editor')).toContain(order);
    const current = await ctx.repos.drafts.current(c2.id);
    expect(current!.prose).toContain('*Tell no one,* she remembered.');
    expect(current!.notes).toMatch(/^Deepening pass/);
    expect(kit.queued.find((j) => j.type === 'chapter.cohesion')!.data.draftId).toBe(current!.id);
    expect((await getReview(ctx, c2.id)).chapter.status).toBe('needs_recheck');
  });
});
