import {
  type ArcStatus,
  ConflictError,
  GateError,
  NotFoundError,
  type OutlineChapter,
  type ReplanItem,
  applyReplan,
  normalizeCard,
  planUnlock,
  replanChangeProblems,
  runReplanner,
  validateOutline,
} from '@storyforge/core';
import { type Repos, cardsAsOf, inTransaction } from '@storyforge/db';
import { toBibleContent } from './bible.js';
import type { ServiceContext } from './context.js';
import { requestCohesion } from './drafting.js';

export interface ReplanJobInput {
  projectId: string;
  afterChapter: number;
}

export async function requestReplan(ctx: ServiceContext, projectId: string, afterChapter: number) {
  const input: ReplanJobInput = { projectId, afterChapter };
  const job = await ctx.repos.jobs.create(projectId, 'outline.replan', { ...input });
  await ctx.enqueue({ id: job.id, type: 'outline.replan', data: { ...input } });
  return job;
}

/**
 * Saves an outline change as a new approved version and points every chapter at its new plan.
 * Used by accepted re-plan items and adopted drift; runs inside the caller's transaction.
 */
export async function reviseOutline(repos: Repos, projectId: string, chapters: OutlineChapter[]) {
  const saved = await repos.outlines.createVersion(projectId, chapters);
  await repos.outlines.markApproved(saved.outline.id);
  const rows = await repos.chapters.listForProject(projectId);
  for (const row of rows) {
    const i = saved.chapters.findIndex((c) => c.number === row.number);
    if (i !== -1) await repos.chapters.setOutlineChapter(row.id, saved.chapterIds[i]!);
  }
  return saved;
}

/** Major characters' arcs as they stand now, for the re-planner and the book reviewer. */
export async function arcStatus(ctx: ServiceContext, projectId: string): Promise<ArcStatus[]> {
  const [characters, versions] = await Promise.all([
    ctx.repos.characters.list(projectId),
    ctx.repos.characters.listVersionsForProject(projectId),
  ]);
  const cards = cardsAsOf(versions, Number.MAX_SAFE_INTEGER);
  return characters
    .filter((c) => c.tier === 'major')
    .map((c) => {
      const card = normalizeCard(cards.get(c.id)?.card, c.firstChapter ?? 1);
      return {
        character: c.name,
        arcStart: card.arcStart,
        arcEnd: card.arcEnd,
        checkpoints: card.checkpoints,
      };
    });
}

/** The outline.replan job: proposes a diff for the remaining chapters, pending author review. */
export async function replanOutline(ctx: ServiceContext, jobId: string, input: ReplanJobInput) {
  const [project, bibleRow, outline, chapters, promises, drift] = await Promise.all([
    ctx.repos.projects.get(input.projectId),
    ctx.repos.bibles.latest(input.projectId),
    ctx.repos.outlines.latest(input.projectId),
    ctx.repos.chapters.listForProject(input.projectId),
    ctx.repos.promises.list(input.projectId),
    ctx.repos.drift.listForProject(input.projectId),
  ]);
  if (!project || !bibleRow || !outline) throw new NotFoundError('Outline');
  const bible = toBibleContent(project, bibleRow);
  const numberOf = new Map(chapters.map((c) => [c.id, c.number]));
  const lockedThrough = Math.max(
    input.afterChapter,
    ...chapters.filter((c) => c.status === 'locked').map((c) => c.number),
  );

  const out = await runReplanner(ctx.agentContext(project.id, { jobId }), {
    bible,
    outline: outline.chapters,
    lockedThrough,
    lockedSummaries: chapters.flatMap((c) =>
      c.status === 'locked' && c.summary ? [{ number: c.number, summary: c.summary }] : [],
    ),
    openPromises: promises
      .filter((p) => p.status === 'open')
      .map((p) => ({ description: p.description, ...p.window })),
    driftAdoptions: drift
      .filter((d) => d.resolution === 'adopt')
      .map((d) => ({
        chapter: numberOf.get(d.chapterId) ?? 0,
        kind: d.kind,
        description: d.description,
        adopted: d.details.adoptText,
      })),
    arcs: await arcStatus(ctx, project.id),
  });

  const items: ReplanItem[] = out.changes
    .map((c) => ({ c, before: outline.chapters.find((o) => o.number === c.chapter)! }))
    .filter(({ c, before }) => JSON.stringify(before) !== JSON.stringify(c.after))
    .map(({ c, before }, i) => ({
      id: `i${i + 1}`,
      chapter: c.chapter,
      reason: c.reason,
      before,
      after: c.after,
      decision: null,
    }));
  const diff = await ctx.repos.replan.create({
    projectId: project.id,
    afterChapter: input.afterChapter,
    items,
    jobId,
  });
  return diff.id;
}

export async function getReplans(ctx: ServiceContext, projectId: string) {
  const [open, job] = await Promise.all([
    ctx.repos.replan.listOpen(projectId),
    ctx.repos.jobs.latest(projectId, 'outline.replan'),
  ]);
  return {
    diffs: open.map((d) => ({
      id: d.id,
      afterChapter: d.afterChapter,
      items: d.items,
      createdAt: d.createdAt,
    })),
    job: job && { id: job.id, status: job.status, error: job.error },
  };
}

/**
 * Accepts or rejects one proposed change. Accepting writes a new outline version, provided the
 * chapter has not started, anchors stay put, and the outline still fits the spine.
 */
export async function decideReplanItem(
  ctx: ServiceContext,
  projectId: string,
  diffId: string,
  itemId: string,
  decision: 'accept' | 'reject',
) {
  const diff = await ctx.repos.replan.get(diffId);
  if (!diff || diff.projectId !== projectId) throw new NotFoundError('Re-plan');
  const item = diff.items.find((i) => i.id === itemId);
  if (!item) throw new NotFoundError('Re-plan change');
  if (item.decision) throw new ConflictError('This change has already been decided');

  const decided = diff.items.map((i) =>
    i.id === itemId
      ? { ...i, decision: decision === 'accept' ? ('accepted' as const) : ('rejected' as const) }
      : i,
  );
  if (decision === 'reject') return ctx.repos.replan.setItems(diff.id, decided);

  const [outline, chapters, bibleRow] = await Promise.all([
    ctx.repos.outlines.latest(projectId),
    ctx.repos.chapters.listForProject(projectId),
    ctx.repos.bibles.latest(projectId),
  ]);
  if (!outline || !bibleRow) throw new NotFoundError('Outline');
  const row = chapters.find((c) => c.number === item.chapter);
  if (row?.status !== 'planned') {
    throw new GateError(
      `Chapter ${item.chapter} has already started; edit its plan by hand instead`,
    );
  }
  const current = outline.chapters.find((c) => c.number === item.chapter);
  const lockedThrough = Math.max(
    0,
    ...chapters.filter((c) => c.status === 'locked').map((c) => c.number),
  );
  const next = applyReplan(outline.chapters, [item]);
  const problems = [
    ...replanChangeProblems(current, item, lockedThrough),
    ...validateOutline(next, bibleRow.spine),
  ];
  if (problems.length) throw new GateError('This change no longer fits the outline', problems);

  await inTransaction(ctx.db, async (repos) => {
    await reviseOutline(repos, projectId, next);
    await repos.replan.setItems(diff.id, decided);
  });
}

/**
 * Unlocks a chapter: it returns to review and every later locked chapter is flagged
 * needs_recheck, with its cohesion check re-run against the current state. Restores nothing.
 */
export async function unlockChapter(ctx: ServiceContext, chapterId: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  if (chapter.status !== 'locked') throw new ConflictError('Only a locked chapter can be unlocked');
  const [project, chapters] = await Promise.all([
    ctx.repos.projects.get(chapter.projectId),
    ctx.repos.chapters.listForProject(chapter.projectId),
  ]);
  if (!project) throw new NotFoundError('Project');
  if (project.status === 'complete') throw new ConflictError('The book is complete');
  const changes = planUnlock(chapters, chapter.number);

  await inTransaction(ctx.db, async (repos) => {
    for (const change of changes) await repos.chapters.setStatus(change.id, change.status);
    if (project.status === 'assembling')
      await repos.projects.transition(project.id, 'assembling', 'writing');
  });

  const flagged = changes.filter((c) => c.status === 'needs_recheck');
  for (const f of flagged) {
    const [row, draft] = await Promise.all([
      ctx.repos.chapters.get(f.id),
      ctx.repos.drafts.current(f.id),
    ]);
    if (row && draft) await requestCohesion(ctx, row, draft.id);
  }
  return {
    flagged: flagged.map((f) => chapters.find((c) => c.id === f.id)!.number),
  };
}
