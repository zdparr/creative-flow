import { ConflictError, GateError } from '@storyforge/core';
import { sampleReplan, seedChapters } from '@storyforge/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updatePromise } from './book.js';
import { getCharacter } from './characters.js';
import {
  applyFix,
  editDraft,
  getReview,
  lockChapter,
  proposeFix,
  regenerateDraft,
  waiveIssue,
} from './drafting.js';
import { endChapter, getPlayState, reopenChapter, startChapter } from './play.js';
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

  it('commits play facts as the revised draft has them', async () => {
    const { ctx } = kit;
    const { project, chapters } = await seededProject(ctx);
    const seed = seedChapters[1];
    kit.llm.push(seed.opening, seed.extraction);
    await startChapter(ctx, chapters[0]!.id, recorder().sink);
    await endChapter(ctx, chapters[0]!.id);
    await runQueued(kit, 'chapter.novelize', seed.prose);
    // The author revised the letter's date after play; the critic reports the change.
    await runQueued(kit, 'chapter.cohesion', {
      ...seed.critic,
      factCorrections: [
        { ref: 'P1', corrected: 'Maren has a letter addressed to Isla, dated last winter.' },
      ],
    });
    expect(lastCriticPrompt()).toContain(
      'P1 [object] Maren has a letter addressed to Isla, dated next spring.',
    );

    await lockChapter(ctx, chapters[0]!.id);
    const facts = await ctx.repos.ledger.listAll(project.id);
    expect(facts.map((f) => f.statement)).toEqual([
      'Maren has a letter addressed to Isla, dated last winter.',
    ]);
    const knowledge = await ctx.repos.knowledge.list(project.id);
    expect(knowledge).toMatchObject([{ factId: facts[0]!.id }]);
  });

  it('drops a play fact the revised draft no longer contains', async () => {
    const { ctx } = kit;
    const { project, chapters } = await seededProject(ctx);
    const seed = seedChapters[1];
    kit.llm.push(seed.opening, seed.extraction);
    await startChapter(ctx, chapters[0]!.id, recorder().sink);
    await endChapter(ctx, chapters[0]!.id);
    await runQueued(kit, 'chapter.novelize', seed.prose);
    await runQueued(kit, 'chapter.cohesion', {
      ...seed.critic,
      factCorrections: [{ ref: 'P1', corrected: '' }],
    });

    await lockChapter(ctx, chapters[0]!.id);
    expect(await ctx.repos.ledger.listAll(project.id)).toEqual([]);
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

  it('proposes an AI fix for an issue, applies it on approval, and re-checks', async () => {
    const { ctx, llm } = kit;
    const { chapters } = await seededProject(ctx);
    await draftSeedChapter(kit, chapters[0]!.id, 1);
    await lockChapter(ctx, chapters[0]!.id);
    await runQueued(kit, 'outline.replan', sampleReplan);
    const c2 = chapters[1]!.id;
    await draftSeedChapter(kit, c2, 2);

    // The author waives the promise blocker, then asks for a fix to the knowledge blocker.
    await waiveIssue(ctx, c2, 'r1', 'Extending the promise later');
    const fixed =
      '"The light closes at the end of the month," he said, and set the order on the table.';
    llm.push({
      edits: [{ paragraph: 2, text: fixed }],
      move: null,
      explanation: 'Tomas no longer mentions the letters.',
    });
    const proposal = await proposeFix(ctx, c2, 'c1');
    expect(proposal).toMatchObject({
      draftVersion: 1,
      edits: [{ paragraph: 2, after: fixed }],
    });
    expect(proposal.edits[0]!.before).toContain('letters to your sister');
    const prompt = llm.requests.at(-1)!.messages[0]!.content as string;
    expect(prompt).toContain('Tomas mentions the letters to Isla');
    // The fixer revises against everything the critic checks, so a fix does not break it.
    expect(prompt).toContain('Maren Tull knows: Maren has a letter addressed to Isla');
    expect(prompt).toContain('[ch 1, object] Maren has a letter addressed to Isla');
    expect(prompt).toContain('s2-b1: Tomas delivers the decommission order.');
    // Waived issues are not listed as open; the others are.
    expect(prompt).toContain(
      '# Other open issues (do not make these worse or add new ones)\n(none)',
    );
    // Nothing changes until the author approves.
    expect((await getReview(ctx, c2)).draft?.version).toBe(1);

    // The author tweaks the wording, approves, and the draft and report move on.
    await applyFix(ctx, c2, 'c1', {
      draftVersion: 1,
      edits: [{ paragraph: 2, text: `${fixed} He did not sit.` }],
    });
    let review = await getReview(ctx, c2);
    expect(review.draft?.version).toBe(2);
    expect(review.paragraphs[0]).toBe(seedChapters[2].prose.split('\n\n')[0]);
    expect(review.paragraphs[1]).toBe(`${fixed} He did not sit.`);
    expect(review.job).toMatchObject({ type: 'chapter.cohesion', status: 'queued' });
    await expect(
      applyFix(ctx, c2, 'c1', { draftVersion: 1, edits: [{ paragraph: 2, text: 'x' }] }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The re-check no longer finds the knowledge problem and keeps the promise waiver.
    await runQueued(kit, 'chapter.cohesion', { ...seedChapters[2].critic, issues: [] });
    review = await getReview(ctx, c2);
    expect(review.report?.issues.map((i) => i.category)).toEqual(['promise']);
    expect(review.report?.waived).toMatchObject([
      { issueId: 'r1', reason: 'Extending the promise later' },
    ]);
    expect(review.canLock).toBe(true);
  });

  it('moves paragraphs and their scenes to the next chapter as a new required beat', async () => {
    const { ctx, llm } = kit;
    const { project, chapters } = await seededProject(ctx);
    const c1 = chapters[0]!.id;
    await draftSeedChapter(kit, c1, 1);
    // The critic finds that the chapter runs into the next chapter's material.
    await editDraft(ctx, c1, seedChapters[1].prose);
    await runQueued(kit, 'chapter.cohesion', {
      ...seedChapters[1].critic,
      issues: [
        {
          severity: 'warning',
          category: 'pacing',
          paragraph: 2,
          description: 'The bottle belongs to the next chapter.',
          evidence: 'Chapter 2 opens on the letters.',
          suggestedFix: 'Move paragraph 2 to chapter 2.',
        },
      ],
    });

    const beat = 'Maren finds a green bottle at the tideline holding a letter to Isla.';
    llm.push({
      edits: [],
      move: { paragraphs: [2, 2], scenes: [1], beat },
      explanation: 'The discovery opens chapter 2 instead.',
    });
    const proposal = await proposeFix(ctx, c1, 'c1');
    expect(proposal.move).toMatchObject({
      toChapter: 2,
      paragraphs: [{ paragraph: 2, text: seedChapters[1].prose.split('\n\n')[1] }],
      scenes: [{ summary: seedChapters[1].extraction.summary }],
      beat,
    });
    const prompt = llm.requests.at(-1)!.messages[0]!.content as string;
    expect(prompt).toContain(`[1] ${seedChapters[1].extraction.summary} (hits beats: s1-b1)`);
    expect(prompt).toContain('# The next chapter (content may move here)\nChapter 2:');

    await applyFix(ctx, c1, 'c1', {
      draftVersion: proposal.draftVersion,
      edits: [],
      move: {
        paragraphs: [2],
        sceneIds: proposal.move!.scenes.map((s) => s.id),
        beat: proposal.move!.beat,
      },
    });
    const review = await getReview(ctx, c1);
    expect(review.paragraphs).toEqual([seedChapters[1].prose.split('\n\n')[0]]);
    expect(review.draft?.notes).toBe('Moved ¶2 to chapter 2 (pacing)');
    expect(review.job).toMatchObject({ type: 'chapter.cohesion', status: 'queued' });
    // The next chapter must now play it.
    const outline = await ctx.repos.outlines.latest(project.id);
    expect(outline!.chapters[1]!.requiredBeats.at(-1)).toEqual({
      id: 'c2-moved-1',
      description: `From chapter 1: ${beat}`,
    });
    expect((await getPlayState(ctx, chapters[1]!.id)).beats.map((b) => b.id)).toContain(
      'c2-moved-1',
    );

    // The moved scene's facts are not locked into chapter 1.
    await runQueued(kit, 'chapter.cohesion', seedChapters[1].critic);
    await lockChapter(ctx, c1);
    const facts = await ctx.repos.ledger.listActive(project.id);
    expect(facts.map((f) => f.statement)).not.toContain(
      seedChapters[1].extraction.facts[0]!.statement,
    );
  });

  it('supports inline edits, re-checks, regeneration with notes, waivers, and return to play', async () => {
    const { ctx, llm } = kit;
    const { chapters } = await seededProject(ctx);
    const chapter = chapters[0]!;
    await draftSeedChapter(kit, chapter.id, 1);

    // An inline edit is a new version that queues its own re-check; no lock until it reports.
    await editDraft(ctx, chapter.id, 'The lamp turned.\n\nThe bottle waited.');
    let review = await getReview(ctx, chapter.id);
    expect(review.draft?.version).toBe(2);
    expect(review.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(review.job).toMatchObject({ type: 'chapter.cohesion', status: 'queued' });
    expect(review.gates.reportMissing).toBe(true);
    expect(review.canLock).toBe(false);
    await expect(lockChapter(ctx, chapter.id)).rejects.toBeInstanceOf(GateError);
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
