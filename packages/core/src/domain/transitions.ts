import type { ChapterStatus, ProjectStatus } from './status.js';

/** Forward transitions only; every one of them is an explicit author action. */
const PROJECT_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  intake: ['bible_review'],
  bible_review: ['outline_review'],
  outline_review: ['writing'],
  writing: ['assembling'],
  // The author can leave assembly to revise flagged chapters.
  assembling: ['writing', 'complete'],
  complete: [],
};

const CHAPTER_TRANSITIONS: Record<ChapterStatus, readonly ChapterStatus[]> = {
  planned: ['playing'],
  playing: ['drafting'],
  // A failed novelize job or an author "revise" returns to play.
  drafting: ['review', 'playing'],
  review: ['locked', 'playing', 'drafting'],
  locked: ['review'],
  needs_recheck: ['review', 'locked'],
};

export class IllegalTransitionError extends Error {
  constructor(kind: 'project' | 'chapter', from: string, to: string) {
    super(`Illegal ${kind} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

export function assertProjectTransition(from: ProjectStatus, to: ProjectStatus): void {
  if (!canTransitionProject(from, to)) throw new IllegalTransitionError('project', from, to);
}

export function canTransitionChapter(from: ChapterStatus, to: ChapterStatus): boolean {
  return CHAPTER_TRANSITIONS[from].includes(to);
}

export function assertChapterTransition(from: ChapterStatus, to: ChapterStatus): void {
  if (!canTransitionChapter(from, to)) throw new IllegalTransitionError('chapter', from, to);
}

/**
 * Unlocking chapter N sends it back to review and flags every later locked chapter
 * `needs_recheck`. Returns the status changes to apply; restores nothing.
 */
export function planUnlock(
  chapters: readonly { id: string; number: number; status: ChapterStatus }[],
  unlockNumber: number,
): { id: string; status: ChapterStatus }[] {
  const target = chapters.find((c) => c.number === unlockNumber);
  if (!target) throw new Error(`No chapter ${unlockNumber}`);
  assertChapterTransition(target.status, 'review');
  return [
    { id: target.id, status: 'review' },
    ...chapters
      .filter((c) => c.number > unlockNumber && c.status === 'locked')
      .map((c) => ({ id: c.id, status: 'needs_recheck' as const })),
  ];
}
