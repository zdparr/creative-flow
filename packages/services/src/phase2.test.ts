import { ConflictError, GateError } from '@storyforge/core';
import {
  FakeLlm,
  sampleBible,
  sampleInterviewBible,
  sampleInterviewRound,
  sampleOutline,
  samplePitch,
} from '@storyforge/core/testing';
import { createRepos } from '@storyforge/db';
import { createTestDb } from '@storyforge/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveBible, getBible, regenerateSection, updateBible } from './bible.js';
import { type Enqueue, type ServiceContext, createServiceContext } from './context.js';
import { advanceInterview, createProject, submitAnswers } from './interview.js';
import { approveOutline, generateOutline, getOutline, updateOutline } from './outline.js';

let close: () => Promise<void>;
let ctx: ServiceContext;
let llm: FakeLlm;
let queued: Parameters<Enqueue>[0][];
let userId: string;

beforeEach(async () => {
  const test = await createTestDb();
  close = test.close;
  llm = new FakeLlm();
  queued = [];
  ctx = createServiceContext({ db: test.db, llm, enqueue: async (job) => void queued.push(job) });
  userId = (await createRepos(test.db).users.findOrCreateByEmail('author@example.com')).id;
});
afterEach(() => close());

const answerAll = (round: { questions: { id: string }[] }) =>
  round.questions.map((q) => ({ questionId: q.id, kind: 'answer' as const, text: 'Yes' }));

async function projectAt(id: string) {
  return (await ctx.repos.projects.get(id))!;
}

/** Plays the interview through three rounds to the draft bible. */
async function interviewToBible() {
  const project = await createProject(ctx, userId, samplePitch);
  llm.push(
    sampleInterviewRound(1),
    sampleInterviewRound(2),
    sampleInterviewRound(3),
    sampleInterviewBible,
  );
  let step = await advanceInterview(ctx, project.id);
  for (let i = 0; i < 3; i++) {
    if (step.kind !== 'questions') throw new Error('expected questions');
    step = await submitAnswers(ctx, project.id, step.round.id, answerAll(step.round));
  }
  expect(step.kind).toBe('bible');
  return projectAt(project.id);
}

describe('Phase 2: pitch to approved outline', () => {
  it('produces an approved bible and approved outline end to end', async () => {
    const project = await interviewToBible();
    expect(project.status).toBe('bible_review');
    expect(project.title).toBe('The Tide Letters');

    const job = await approveBible(ctx, project);
    expect((await projectAt(project.id)).status).toBe('outline_review');
    expect(queued).toEqual([
      { id: job.id, type: 'outline.generate', data: { projectId: project.id } },
    ]);

    llm.push(sampleOutline);
    await generateOutline(ctx, job.id, { projectId: project.id });
    const view = await getOutline(ctx, await projectAt(project.id));
    expect(view.outline?.chapters).toHaveLength(4);
    expect(view.outline?.problems).toEqual([]);

    await approveOutline(ctx, await projectAt(project.id));
    expect((await projectAt(project.id)).status).toBe('writing');
    const chapters = await ctx.repos.outlines.listChapters(project.id);
    expect(chapters.map((c) => [c.number, c.status])).toEqual([
      [1, 'planned'],
      [2, 'planned'],
      [3, 'planned'],
      [4, 'planned'],
    ]);

    // Every model call was logged with cost against the project.
    const calls = await ctx.repos.llmCalls.listForProject(project.id);
    expect(calls.map((c) => c.agent)).toEqual([
      'interviewer',
      'interviewer',
      'interviewer',
      'interviewer',
      'outliner',
    ]);
    expect(calls.at(-1)!.jobId).toBe(job.id);
  });

  it('returns the pending round instead of calling the model again', async () => {
    const project = await createProject(ctx, userId, samplePitch);
    llm.push(sampleInterviewRound(1));
    const first = await advanceInterview(ctx, project.id);
    const again = await advanceInterview(ctx, project.id);
    expect(again).toEqual(first);
    expect(llm.requests).toHaveLength(1);
  });

  it('resolves two concurrent advances to the same round', async () => {
    const project = await createProject(ctx, userId, samplePitch);
    llm.push(sampleInterviewRound(1), sampleInterviewRound(1));
    const [a, b] = await Promise.all([
      advanceInterview(ctx, project.id),
      advanceInterview(ctx, project.id),
    ]);
    if (a.kind !== 'questions' || b.kind !== 'questions') throw new Error('expected questions');
    expect(a.round.id).toBe(b.round.id);
    expect(await ctx.repos.interview.list(project.id)).toHaveLength(1);
  });

  it('rejects answering the same round twice', async () => {
    const project = await createProject(ctx, userId, samplePitch);
    llm.push(sampleInterviewRound(1), sampleInterviewRound(2));
    const step = await advanceInterview(ctx, project.id);
    if (step.kind !== 'questions') throw new Error('expected questions');
    await submitAnswers(ctx, project.id, step.round.id, []);
    await expect(submitAnswers(ctx, project.id, step.round.id, [])).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('bible gate', () => {
  it('blocks approval until the spine is complete, and versions every edit', async () => {
    const project = await interviewToBible();
    await updateBible(ctx, project, {
      ...sampleBible,
      spine: { ...sampleBible.spine, theme: '' },
    });
    await expect(approveBible(ctx, await projectAt(project.id))).rejects.toMatchObject({
      problems: ['Theme statement is empty'],
    });

    llm.push({ ...sampleBible.spine, theme: 'Letting go is a kind of keeping.' });
    await regenerateSection(ctx, await projectAt(project.id), 'spine', 'Give it a theme');
    const view = await getBible(ctx, await projectAt(project.id));
    expect(view?.version).toBe(3);
    expect(view?.spineProblems).toEqual([]);
    expect(view?.versions.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('refuses edits after approval', async () => {
    const project = await interviewToBible();
    await approveBible(ctx, project);
    await expect(updateBible(ctx, await projectAt(project.id), sampleBible)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('outline gate', () => {
  async function toOutlineReview() {
    const project = await interviewToBible();
    const job = await approveBible(ctx, project);
    llm.push(sampleOutline);
    await generateOutline(ctx, job.id, { projectId: project.id });
    return projectAt(project.id);
  }

  it('renumbers on reorder and blocks approval when an anchor moves', async () => {
    const project = await toOutlineReview();
    const reordered = [...sampleOutline.chapters].reverse();
    await updateOutline(ctx, project, reordered);
    const view = await getOutline(ctx, project);
    expect(view.outline?.chapters.map((c) => c.number)).toEqual([1, 2, 3, 4]);
    expect(view.outline?.chapters[0]!.title).toBe('The Last Letter');
    await expect(approveOutline(ctx, project)).rejects.toBeInstanceOf(GateError);
  });

  it('reuses an active outline job instead of queueing a duplicate', async () => {
    const project = await interviewToBible();
    const first = await approveBible(ctx, project);
    const { requestOutline } = await import('./outline.js');
    const second = await requestOutline(ctx, project.id, 'again');
    expect(second.id).toBe(first.id);
    expect(queued).toHaveLength(1);
  });
});
