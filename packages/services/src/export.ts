import { ConflictError, NotFoundError, chapterFileName, chapterToDocx } from '@storyforge/core';
import type { ServiceContext } from './context.js';

/**
 * A locked chapter's final prose as a Word document. Only locked chapters are final, and the
 * file holds the approved draft alone: no turns, notes, or chronicle.
 */
export async function exportChapterDocx(ctx: ServiceContext, chapterId: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  if (chapter.status !== 'locked') {
    throw new ConflictError('Only locked chapters can be downloaded');
  }
  const [project, plan, draft] = await Promise.all([
    ctx.repos.projects.get(chapter.projectId),
    ctx.repos.chapters.plan(chapter),
    ctx.repos.drafts.current(chapter.id),
  ]);
  if (!project || !draft) throw new NotFoundError('Final draft');
  const buffer = await chapterToDocx({
    bookTitle: project.title,
    chapterNumber: chapter.number,
    chapterTitle: plan?.title ?? '',
    prose: draft.prose,
  });
  return { fileName: chapterFileName(project.title, chapter.number), buffer };
}
