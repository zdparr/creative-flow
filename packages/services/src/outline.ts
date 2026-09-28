import {
  ConflictError,
  GateError,
  NotFoundError,
  outlineChapterSchema,
  runOutliner,
  validateOutline,
} from '@storyforge/core';
import { type Project, inTransaction } from '@storyforge/db';
import { z } from 'zod';
import { toBibleContent } from './bible.js';
import type { ServiceContext } from './context.js';

export interface OutlineJobInput {
  projectId: string;
  notes?: string;
}

async function approvedBible(ctx: ServiceContext, projectId: string) {
  const project = await ctx.repos.projects.get(projectId);
  const row = await ctx.repos.bibles.latest(projectId);
  if (!project || !row?.approvedAt) throw new ConflictError('The bible has not been approved');
  return toBibleContent(project, row);
}

/** Enqueues outline generation, returning the existing job if one is already queued or running. */
export async function requestOutline(ctx: ServiceContext, projectId: string, notes?: string) {
  const project = await ctx.repos.projects.get(projectId);
  if (project?.status !== 'outline_review') {
    throw new ConflictError('An outline can only be generated while the outline is in review');
  }
  const active = await ctx.repos.jobs.findActive(projectId, 'outline.generate');
  if (active) return active;

  const input: OutlineJobInput = { projectId, ...(notes?.trim() ? { notes: notes.trim() } : {}) };
  const job = await ctx.repos.jobs.create(projectId, 'outline.generate', { ...input });
  await ctx.enqueue({ id: job.id, type: 'outline.generate', data: { ...input } });
  return job;
}

/** The outline.generate job: runs the outliner and saves the result as a new outline version. */
export async function generateOutline(ctx: ServiceContext, jobId: string, input: OutlineJobInput) {
  const bible = await approvedBible(ctx, input.projectId);
  const previous = input.notes ? await ctx.repos.outlines.latest(input.projectId) : null;
  const out = await runOutliner(ctx.agentContext(input.projectId, { jobId }), {
    bible,
    ...(previous ? { previous: previous.chapters } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  });
  const saved = await ctx.repos.outlines.createVersion(input.projectId, out.chapters);
  return saved.outline.id;
}

export async function getOutline(ctx: ServiceContext, project: Project) {
  const [latest, job] = await Promise.all([
    ctx.repos.outlines.latest(project.id),
    ctx.repos.jobs.latest(project.id, 'outline.generate'),
  ]);
  const bible = await ctx.repos.bibles.latest(project.id);
  return {
    outline: latest && {
      version: latest.outline.version,
      approvedAt: latest.outline.approvedAt,
      chapters: latest.chapters,
      problems: bible ? validateOutline(latest.chapters, bible.spine) : [],
    },
    versions: await ctx.repos.outlines.listVersions(project.id),
    job: job && { id: job.id, status: job.status, error: job.error, createdAt: job.createdAt },
  };
}

const chapterListSchema = z.array(outlineChapterSchema);

/** Saves an author edit (including reorders) as a new outline version. Chapters are renumbered by position. */
export async function updateOutline(ctx: ServiceContext, project: Project, input: unknown) {
  if (project.status !== 'outline_review') {
    throw new ConflictError('The outline can only be edited before it is approved');
  }
  const parsed = chapterListSchema.safeParse(input);
  if (!parsed.success) {
    throw new GateError(
      'Outline is malformed',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const chapters = parsed.data.map((c, i) => ({ ...c, number: i + 1 }));
  await ctx.repos.outlines.createVersion(project.id, chapters);
}

/** The outline gate: structurally valid against the spine, then the project moves to writing. */
export async function approveOutline(ctx: ServiceContext, project: Project) {
  if (project.status !== 'outline_review') throw new ConflictError('The outline is not in review');
  const [latest, bible] = await Promise.all([
    ctx.repos.outlines.latest(project.id),
    ctx.repos.bibles.latest(project.id),
  ]);
  if (!latest || !bible) throw new NotFoundError('Outline');
  const problems = validateOutline(latest.chapters, bible.spine);
  if (problems.length) throw new GateError('The outline does not fit the spine', problems);

  await inTransaction(ctx.db, async (repos) => {
    await repos.outlines.markApproved(latest.outline.id);
    await repos.outlines.createChapters(project.id, latest);
    await repos.projects.transition(project.id, 'outline_review', 'writing');
  });
}
