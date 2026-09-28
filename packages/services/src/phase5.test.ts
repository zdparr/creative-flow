import { GateError } from '@storyforge/core';
import { sampleReplan, seedChapters } from '@storyforge/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updatePromise } from './book.js';
import { getCharacter } from './characters.js';
import {
  editDraft,
  getReview,
  lockChapter,
  recheckDraft,
  regenerateDraft,
  waiveIssue,
} from './drafting.js';
import { endChapter, reopenChapter, startChapter } from './play.js';
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
beforeEach(async () => {
  kit = await createTestKit();
});
afterEach(() => kit.close());

/** The most recent request the cohesion critic received. */
const lastCriticPrompt = () =>
  kit.llm.requests.findLast((r) => r.system.includes('cohesion critic'))!.messages[0]!
    .content as string;

describe('Phase 5: novelize, cohesion, lock', () => {
  it("catches the seeded test book's three planted violations", async () => {
    const { ctx } = kit;
    const { project, chapters, tomas } = await seededProject(ctx);
    const [c1, c2, c3] = chapters as [
      (typeof chapters)[0],
      (typeof chapters)[0],
      (typeof chapters)[0],
    ];

    // Chapter 1 is clean: it plants the promise and locks.
    let review = await draftSeedChapter(kit, c1.id, 1);
    expect(review.chapter.status).toBe('review');
    expect(review.report?.issues).toEqual([]);
    expect(review.canLock).toBe(true);
    await lockChapter(ctx, c1.id);
    await runQueued(kit, 'outline.replan', sampleReplan);

    const promises = await ctx.repos.promises.list(project.id);
    expect(promises).toMatchObject([
      { description: 'Who is writing the letters?', status: 'open', window: { from: 2, to: 2 } },
    ]);

    // Chapter 2: the promise's window closes unpaid, and Tomas knows what he cannot.
    review = await draftSeedChapter(kit, c2.id, 2);
    const blockers2 = review.report!.issues.filter((i) => i.severity === 'blocker');
    expect(blockers2.map((i) => [i.category, i.source])).toEqual([
      ['promise', 'rules'],
      ['knowledge', 'critic'],
    ]);
    expect(review.canLock).toBe(false);
    // The critic was given the evidence it needed: who knows what, and the open promise.
    let prompt = lastCriticPrompt();
    expect(prompt).toContain('Maren Tull knows: Maren has a letter addressed to Isla');
    expect(prompt).not.toContain('Tomas Reyne knows');
    expect(prompt).toContain('Who is writing the letters? (pay off in chapters 2-2)');
    expect(prompt).toContain('[2] "The light closes');

    await expect(lockChapter(ctx, c2.id)).rejects.toMatchObject({
      problems: ['2 blocker(s) not fixed or waived'],
    });
    await waiveAndLock(kit, c2.id);
    // Waiving does not close the promise; the author drops it so it stops blocking.
    await updatePromise(ctx, project.id, promises[0]!.id, { status: 'dropped' });

    // Chapter 3: Tomas breaks his principle; his checkpoint version awaits approval.
    review = await draftSeedChapter(kit, c3.id, 3);
    const blockers3 = review.report!.issues.filter((i) => i.severity === 'blocker');
    expect(blockers3.map((i) => i.category)).toEqual(['principle']);
    prompt = lastCriticPrompt();
    expect(prompt).toContain('Never falsifies an inspection report.');
    expect(review.gates.pendingCards.map((c) => c.name)).toEqual(['Tomas Reyne']);
    const pending = (await getCharacter(ctx, tomas)).pendingVersion;
    expect(pending).toMatchObject({ source: 'checkpoint', effectiveChapter: 3 });
    expect(pending?.card.checkpoints[0]?.met).toBe(true);

    // All three planted violations were caught.
    const caught = [...blockers2, ...blockers3].map((i) => i.category).sort();
    expect(caught).toEqual(['knowledge', 'principle', 'promise']);

    await waiveAndLock(kit, c3.id);
    const final = await ctx.repos.chapters.listForProject(project.id);
    expect(final.map((c) => c.status)).toEqual(['locked', 'locked', 'locked']);
    // The last chapter does not queue a re-plan.
    expect(kit.queued.filter((j) => j.type === 'outline.replan')).toEqual([]);
  });

  it('commits ledger, knowledge, promises, summary, and snapshot at lock', async () => {
    const { ctx } = kit;
    const { project, chapters } = await seededProject(ctx);
    await draftSeedChapter(kit, chapters[0]!.id, 1);
    // Nothing extracted in play is committed before the lock.
    expect(await ctx.repos.ledger.listAll(project.id)).toEqual([]);

    await lockChapter(ctx, chapters[0]!.id);
    const facts = await ctx.repos.ledger.listAll(project.id);
    expect(facts.map((f) => f.statement)).toEqual([
      'Maren has a letter addressed to Isla, dated next spring.',
    ]);
    const knowledge = await ctx.repos.knowledge.list(project.id);
    expect(knowledge).toMatchObject([{ factId: facts[0]!.id, learnedChapter: 1 }]);
    const chapter = (await ctx.repos.chapters.get(chapters[0]!.id))!;
    expect(chapter.status).toBe('locked');
    expect(chapter.summary).toContain('letter to her dead sister');
    expect(chapter.lockedSnapshotId).toBeTruthy();
  });

  it('rolls the whole lock back when any part of it fails', async () => {
    const { ctx } = kit;
    const { project, chapters } = await seededProject(ctx);
    const review = await draftSeedChapter(kit, chapters[0]!.id, 1);
    // A report whose promise cannot be stored makes the transaction fail after facts were written.
    await ctx.repos.cohesion.create({
      projectId: project.id,
      chapterId: chapters[0]!.id,
      draftId: review.draft!.id,
      issues: [],
      summary: 'x',
      paidPromiseIds: [],
      plantedPromises: [{ description: 'Bad', type: 'not_a_type' as 'mystery', payoffChapter: 2 }],
      checkpointsMet: [],
      jobId: null,
    });
    await expect(lockChapter(ctx, chapters[0]!.id)).rejects.toThrow();

    expect(await ctx.repos.ledger.listAll(project.id)).toEqual([]);
    expect(await ctx.repos.knowledge.list(project.id)).toEqual([]);
    expect(await ctx.repos.promises.list(project.id)).toEqual([]);
    const chapter = (await ctx.repos.chapters.get(chapters[0]!.id))!;
    expect(chapter.status).toBe('review');
    expect(chapter.lockedSnapshotId).toBeNull();
    expect(chapter.summary).toBeNull();
  });

  it('retries a draft that breaks the house style, and flags what remains', async () => {
    const { ctx, llm } = kit;
    const { chapters } = await seededProject(ctx);
    const chapter = chapters[0]!;
    const seed = seedChapters[1];
    llm.push(seed.opening, seed.extraction);
    await startChapter(ctx, chapter.id, recorder().sink);
    await endChapter(ctx, chapter.id);

    const dashy = 'She waited — and the tide came in.\n\nSuddenly the bottle was there.';
    await runQueued(kit, 'chapter.novelize', dashy, dashy);
    const retry = llm.requests.at(-1)!.messages.at(-1)!.content as string;
    expect(retry).toContain('Dash outside cut-off speech');
    expect(retry).toContain('Banned phrase used: "suddenly"');

    await runQueued(kit, 'chapter.cohesion', { ...seed.critic, promisesPlanted: [] });
    const review = await getReview(ctx, chapter.id);
    const style = review.report!.issues.filter((i) => i.category === 'style');
    expect(style.map((i) => [i.paragraph, i.severity])).toEqual([
      [1, 'warning'],
      [2, 'warning'],
    ]);
  });

  it('supports inline edits, re-checks, regeneration with notes, waivers, and return to play', async () => {
    const { ctx, llm } = kit;
    const { chapters } = await seededProject(ctx);
    const chapter = chapters[0]!;
    await draftSeedChapter(kit, chapter.id, 1);

    // An inline edit is a new version; its report must be re-run before lock.
    await editDraft(ctx, chapter.id, 'The lamp turned.\n\nThe bottle waited.');
    let review = await getReview(ctx, chapter.id);
    expect(review.draft?.version).toBe(2);
    expect(review.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(review.gates.reportMissing).toBe(true);
    expect(review.canLock).toBe(false);
    await expect(lockChapter(ctx, chapter.id)).rejects.toBeInstanceOf(GateError);
    await recheckDraft(ctx, chapter.id);
    await runQueued(kit, 'chapter.cohesion', seedChapters[1].critic);
    expect((await getReview(ctx, chapter.id)).canLock).toBe(true);

    // Waivers need a reason.
    await expect(waiveIssue(ctx, chapter.id, 'r1', ' ')).rejects.toBeInstanceOf(GateError);

    // Regenerate with notes: back to drafting, and the novelizer sees the notes and the draft.
    await regenerateDraft(ctx, chapter.id, 'More salt, less sky.');
    review = await getReview(ctx, chapter.id);
    expect(review.chapter.status).toBe('drafting');
    expect(review.job).toMatchObject({
      type: 'chapter.novelize',
      status: 'queued',
      stage: 'Drafting prose',
    });
    await runQueued(kit, 'chapter.novelize', seedChapters[1].prose);
    const prompt = llm.requests.at(-1)!.messages[0]!.content as string;
    expect(prompt).toContain('More salt, less sky.');
    expect(prompt).toContain('The bottle waited.');
    await runQueued(kit, 'chapter.cohesion', seedChapters[1].critic);

    // Return to play from review.
    await reopenChapter(ctx, chapter.id);
    expect((await ctx.repos.chapters.get(chapter.id))!.status).toBe('playing');
  });
});
