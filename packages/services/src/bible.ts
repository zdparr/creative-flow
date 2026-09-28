import {
  type BibleContent,
  type BibleSection,
  ConflictError,
  GateError,
  NotFoundError,
  bibleContentSchema,
  reviseBibleSection,
  validateSpine,
} from '@storyforge/core';
import { type BibleRow, type Project, inTransaction } from '@storyforge/db';
import type { ServiceContext } from './context.js';
import { requestOutline } from './outline.js';

export function toBibleContent(project: Project, row: BibleRow): BibleContent {
  return { title: project.title, spine: row.spine, world: row.world, styleGuide: row.styleGuide };
}

export async function getBible(ctx: ServiceContext, project: Project) {
  const row = await ctx.repos.bibles.latest(project.id);
  if (!row) return null;
  return {
    version: row.version,
    approvedAt: row.approvedAt,
    content: toBibleContent(project, row),
    spineProblems: validateSpine(row.spine),
    versions: await ctx.repos.bibles.listVersions(project.id),
  };
}

function assertEditable(project: Project) {
  if (project.status !== 'bible_review') {
    throw new ConflictError('The bible can only be edited before it is approved');
  }
}

/** Saves an author edit as a new bible version. */
export async function updateBible(ctx: ServiceContext, project: Project, input: unknown) {
  assertEditable(project);
  const parsed = bibleContentSchema.safeParse(input);
  if (!parsed.success) {
    throw new GateError(
      'Bible is malformed',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const { title, ...sections } = parsed.data;
  // Line-per-item fields arrive with blank lines while the author is typing.
  const clean = (list: string[]) => list.map((x) => x.trim()).filter(Boolean);
  sections.world.rules = clean(sections.world.rules);
  sections.styleGuide.bannedPhrases = clean(sections.styleGuide.bannedPhrases);
  sections.styleGuide.samples = clean(sections.styleGuide.samples);
  await inTransaction(ctx.db, async (repos) => {
    await repos.bibles.createVersion(project.id, sections);
    if (title.trim() && title !== project.title)
      await repos.projects.setTitle(project.id, title.trim());
  });
}

/** Regenerates one section from the author's notes as a new version. */
export async function regenerateSection(
  ctx: ServiceContext,
  project: Project,
  section: BibleSection,
  notes: string,
) {
  assertEditable(project);
  const row = await ctx.repos.bibles.latest(project.id);
  if (!row) throw new NotFoundError('Bible');
  const bible = toBibleContent(project, row);
  const revised = await reviseBibleSection(ctx.agentContext(project.id), {
    pitch: project.createdFromPitch,
    bible,
    section,
    notes,
  });
  await ctx.repos.bibles.createVersion(project.id, {
    spine: bible.spine,
    world: bible.world,
    styleGuide: bible.styleGuide,
    [section]: revised,
  });
}

/** The bible gate: a complete spine, then outline generation starts. */
export async function approveBible(ctx: ServiceContext, project: Project) {
  assertEditable(project);
  const row = await ctx.repos.bibles.latest(project.id);
  if (!row) throw new NotFoundError('Bible');
  const problems = validateSpine(row.spine);
  if (problems.length) throw new GateError('The spine is incomplete', problems);

  await inTransaction(ctx.db, async (repos) => {
    await repos.bibles.markApproved(row.id);
    await repos.projects.transition(project.id, 'bible_review', 'outline_review');
  });
  return requestOutline(ctx, project.id);
}
