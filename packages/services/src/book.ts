import {
  type BookFormat,
  ConflictError,
  FORMAT_INFO,
  GateError,
  NotFoundError,
  bookFileName,
  renderBook,
  runBookReviewer,
} from '@storyforge/core';
import type { Project } from '@storyforge/db';
import { toBibleContent } from './bible.js';
import type { ServiceContext } from './context.js';
import { arcStatus } from './replan.js';

export interface BookReviewJobInput {
  projectId: string;
}

export interface ExportJobInput {
  projectId: string;
  format: BookFormat;
}

/** Locked chapters with their final prose, in order. */
async function lockedBook(ctx: ServiceContext, projectId: string) {
  const [chapters, drafts] = await Promise.all([
    ctx.repos.chapters.listForProject(projectId),
    ctx.repos.drafts.listCurrentForProject(projectId),
  ]);
  const draftOf = new Map(drafts.map((d) => [d.chapterId, d]));
  return chapters.map((c) => ({ ...c, draft: draftOf.get(c.id) ?? null }));
}

// ---------- assembly ----------

/**
 * Assemble: once every chapter is locked, the project moves to assembling and the book
 * reviewer runs. While assembling, the author can run the review again after revisions.
 */
export async function assembleBook(ctx: ServiceContext, project: Project) {
  const chapters = await ctx.repos.chapters.listForProject(project.id);
  if (project.status === 'writing') {
    const open = chapters.filter((c) => c.status !== 'locked');
    if (open.length) {
      throw new GateError(
        'Every chapter must be locked before the book is assembled',
        open.map((c) => `Chapter ${c.number} is ${c.status.replace('_', ' ')}`),
      );
    }
    await ctx.repos.projects.transition(project.id, 'writing', 'assembling');
  } else if (project.status !== 'assembling') {
    throw new ConflictError('The book is not ready to assemble');
  }
  const active = await ctx.repos.jobs.findActive(project.id, 'book.review');
  if (active) return active;
  const input: BookReviewJobInput = { projectId: project.id };
  const job = await ctx.repos.jobs.create(project.id, 'book.review', { ...input });
  await ctx.enqueue({ id: job.id, type: 'book.review', data: { ...input } });
  return job;
}

/** The book.review job: a whole-book pass for pacing, repetition, theme drift, and dropped threads. */
export async function reviewBook(ctx: ServiceContext, jobId: string, input: BookReviewJobInput) {
  const [project, bibleRow, chapters, promises] = await Promise.all([
    ctx.repos.projects.get(input.projectId),
    ctx.repos.bibles.latest(input.projectId),
    lockedBook(ctx, input.projectId),
    ctx.repos.promises.list(input.projectId),
  ]);
  if (!project || !bibleRow) throw new NotFoundError('Project');
  const out = await runBookReviewer(ctx.agentContext(project.id, { jobId }), {
    bible: toBibleContent(project, bibleRow),
    chapters: chapters.map((c) => ({
      number: c.number,
      title: c.title ?? '',
      summary: c.summary ?? '(no summary)',
      wordCount: c.draft?.wordCount ?? 0,
    })),
    promises: promises.map((p) => ({
      description: p.description,
      status: p.status,
      plantedChapter: p.plantedChapter,
      to: p.window.to,
    })),
    arcs: await arcStatus(ctx, project.id),
  });
  const review = await ctx.repos.bookReviews.create({
    projectId: project.id,
    summary: out.summary,
    issues: out.issues,
    jobId,
  });
  return review.id;
}

/** The author finishes the book. Export stays available. */
export async function completeBook(ctx: ServiceContext, project: Project) {
  if (project.status !== 'assembling') throw new ConflictError('Assemble the book first');
  await ctx.repos.projects.transition(project.id, 'assembling', 'complete');
}

// ---------- export ----------

export async function requestExport(ctx: ServiceContext, project: Project, format: BookFormat) {
  if (project.status !== 'assembling' && project.status !== 'complete') {
    throw new ConflictError('Assemble the book before exporting it');
  }
  const input: ExportJobInput = { projectId: project.id, format };
  const job = await ctx.repos.jobs.create(project.id, 'book.export', { ...input });
  await ctx.enqueue({ id: job.id, type: 'book.export', data: { ...input } });
  return job;
}

/** The book.export job: renders the book and stores it in S3 (or Postgres without a bucket). */
export async function exportBook(ctx: ServiceContext, jobId: string, input: ExportJobInput) {
  const project = await ctx.repos.projects.get(input.projectId);
  if (!project) throw new NotFoundError('Project');
  const [user, chapters] = await Promise.all([
    ctx.repos.users.findById(project.userId),
    lockedBook(ctx, project.id),
  ]);
  const missing = chapters.filter((c) => c.status !== 'locked' || !c.draft);
  if (missing.length) {
    throw new GateError(
      'Every chapter must be locked with a final draft',
      missing.map((c) => `Chapter ${c.number}`),
    );
  }
  const buffer = await renderBook(
    {
      id: project.id,
      title: project.title,
      author: user?.displayName ?? '',
      chapters: chapters.map((c) => ({
        number: c.number,
        title: c.title ?? '',
        prose: c.draft!.prose,
      })),
    },
    input.format,
  );
  const fileName = bookFileName(project.title, input.format);
  let s3Key: string | null = null;
  if (ctx.files) {
    s3Key = `exports/${project.id}/${jobId}/${fileName}`;
    await ctx.files.put(s3Key, buffer, FORMAT_INFO[input.format].contentType);
  }
  const row = await ctx.repos.exports.create({
    projectId: project.id,
    format: input.format,
    fileName,
    byteSize: buffer.length,
    s3Key,
    content: s3Key ? null : buffer,
    jobId,
  });
  return row.id;
}

/** A finished export: a redirect to S3, or the file itself when it is stored in Postgres. */
export async function downloadExport(ctx: ServiceContext, projectId: string, exportId: string) {
  const row = await ctx.repos.exports.get(exportId);
  if (!row || row.projectId !== projectId) throw new NotFoundError('Export');
  const contentType = FORMAT_INFO[row.format].contentType;
  if (row.s3Key) {
    if (!ctx.files) throw new ConflictError('Export storage is not configured');
    return { kind: 'redirect' as const, url: await ctx.files.downloadUrl(row.s3Key, row.fileName) };
  }
  if (!row.content) throw new NotFoundError('Export file');
  return { kind: 'file' as const, fileName: row.fileName, contentType, buffer: row.content };
}

// ---------- the promise registry ----------

/**
 * The author extends an open promise's payoff window or drops it (or reopens a dropped one).
 * Overdue promises block a chapter's lock until one of these, a payoff, or a waiver.
 */
export async function updatePromise(
  ctx: ServiceContext,
  projectId: string,
  promiseId: string,
  change: { status?: 'open' | 'dropped'; extendTo?: number },
) {
  const [promises, bible] = await Promise.all([
    ctx.repos.promises.list(projectId),
    ctx.repos.bibles.latest(projectId),
  ]);
  const promise = promises.find((p) => p.id === promiseId);
  if (!promise || !bible) throw new NotFoundError('Promise');
  if (promise.status === 'paid') throw new ConflictError('This promise has already paid off');
  if (change.extendTo !== undefined) {
    if (change.extendTo < promise.window.to || change.extendTo > bible.spine.chapterCount) {
      throw new GateError(
        `Extend to a chapter between ${promise.window.to} and ${bible.spine.chapterCount}`,
      );
    }
    await ctx.repos.promises.setWindow(promise.id, promise.window.from, change.extendTo);
  }
  if (change.status) await ctx.repos.promises.setStatus(promise.id, change.status);
}

// ---------- the Book screen ----------

/** Token and cost totals by agent and chapter, plus the project total. */
export async function getUsage(ctx: ServiceContext, projectId: string) {
  const [calls, chapters] = await Promise.all([
    ctx.repos.llmCalls.listForProject(projectId),
    ctx.repos.chapters.listForProject(projectId),
  ]);
  const numberOf = new Map(chapters.map((c) => [c.id, c.number]));
  type Total = {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
  };
  const empty = (): Total => ({
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
  });
  const add = (t: Total, c: (typeof calls)[number]) => {
    t.calls += 1;
    t.inputTokens += c.inputTokens;
    t.outputTokens += c.outputTokens;
    t.cachedTokens += c.cachedTokens;
    t.costUsd += Number(c.costUsd);
  };
  const total = empty();
  const byAgent = new Map<string, Total>();
  const byChapter = new Map<number | null, Total>();
  for (const call of calls) {
    add(total, call);
    add(byAgent.get(call.agent) ?? byAgent.set(call.agent, empty()).get(call.agent)!, call);
    const n = call.chapterId ? (numberOf.get(call.chapterId) ?? null) : null;
    add(byChapter.get(n) ?? byChapter.set(n, empty()).get(n)!, call);
  }
  const round = (t: Total) => ({ ...t, costUsd: Math.round(t.costUsd * 10000) / 10000 });
  return {
    total: round(total),
    byAgent: [...byAgent]
      .map(([agent, t]) => ({ agent, ...round(t) }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byChapter: [...byChapter]
      .map(([chapter, t]) => ({ chapter, ...round(t) }))
      .sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0)),
  };
}

export async function getBook(ctx: ServiceContext, project: Project) {
  const [chapters, review, reviewJob, exports, exportJob, usage, promises, ledger] =
    await Promise.all([
      lockedBook(ctx, project.id),
      ctx.repos.bookReviews.latest(project.id),
      ctx.repos.jobs.latest(project.id, 'book.review'),
      ctx.repos.exports.list(project.id),
      ctx.repos.jobs.latest(project.id, 'book.export'),
      getUsage(ctx, project.id),
      ctx.repos.promises.list(project.id),
      ctx.repos.ledger.listAll(project.id),
    ]);
  const job = (j: typeof reviewJob) =>
    j && { id: j.id, status: j.status, error: j.error, input: j.input };
  const numberOf = new Map(chapters.map((c) => [c.id, c.number]));
  return {
    project: { id: project.id, title: project.title, status: project.status },
    chapters: chapters.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      status: c.status,
      wordCount: c.draft?.wordCount ?? 0,
      lockedAt: c.lockedAt,
    })),
    totalWords: chapters.reduce((n, c) => n + (c.draft?.wordCount ?? 0), 0),
    review: review && {
      summary: review.summary,
      issues: review.issues,
      createdAt: review.createdAt,
    },
    reviewJob: job(reviewJob),
    exports,
    exportJob: job(exportJob),
    usage,
    promises: promises.map((p) => ({
      id: p.id,
      type: p.type,
      description: p.description,
      status: p.status,
      plantedChapter: p.plantedChapter,
      window: p.window,
      paidChapter: p.paidChapter,
    })),
    ledger: ledger.map((f) => ({
      id: f.id,
      chapter: numberOf.get(f.chapterId) ?? null,
      kind: f.kind,
      statement: f.statement,
      superseded: !!f.supersededBy,
    })),
    canAssemble:
      project.status === 'writing' &&
      chapters.length > 0 &&
      chapters.every((c) => c.status === 'locked'),
    canExport: project.status === 'assembling' || project.status === 'complete',
  };
}
