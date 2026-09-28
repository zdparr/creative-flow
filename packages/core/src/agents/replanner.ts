import { validateOutline } from '../domain/validation.js';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { loadPrompt } from '../prompts/loader.js';
import type { BibleContent } from '../schemas/bible.js';
import type { OutlineChapter } from '../schemas/outline.js';
import {
  type BookReviewOutput,
  type ReplanOutput,
  bookReviewOutputSchema,
  replanOutputSchema,
} from '../schemas/replan.js';

export interface ArcStatus {
  character: string;
  arcStart: string;
  arcEnd: string;
  checkpoints: { chapter: number; description: string; met: boolean }[];
}

export interface ReplannerInput {
  bible: BibleContent;
  outline: OutlineChapter[];
  /** Chapters up to and including this one are locked. */
  lockedThrough: number;
  lockedSummaries: { number: number; summary: string }[];
  openPromises: { description: string; from: number; to: number }[];
  driftAdoptions: { chapter: number; kind: string; description: string; adopted: string }[];
  arcs: ArcStatus[];
}

/** Applies proposed chapter replacements to an outline (by chapter number). */
export function applyReplan(
  outline: OutlineChapter[],
  changes: { chapter: number; after: OutlineChapter }[],
) {
  const byNumber = new Map(changes.map((c) => [c.chapter, c.after]));
  return outline.map((c) => byNumber.get(c.number) ?? c);
}

/** Why a proposed chapter change breaks the re-plan rules; empty when it is allowed. */
export function replanChangeProblems(
  current: OutlineChapter | undefined,
  change: { chapter: number; after: OutlineChapter },
  lockedThrough: number,
): string[] {
  const at = `chapter ${change.chapter}`;
  if (!current) return [`${at}: there is no such chapter`];
  if (change.chapter <= lockedThrough) return [`${at}: is locked and cannot change`];
  const problems: string[] = [];
  if (change.after.number !== change.chapter) problems.push(`${at}: keep the chapter number`);
  if (
    change.after.isAnchor !== current.isAnchor ||
    change.after.anchorType !== current.anchorType
  ) {
    problems.push(`${at}: anchor beats never move; keep isAnchor and anchorType as they are`);
  }
  return problems;
}

export async function runReplanner(
  ctx: AgentContext,
  input: ReplannerInput,
): Promise<ReplanOutput> {
  const content = [
    `# Spine\n${JSON.stringify(input.bible.spine, null, 2)}`,
    `# Outline (chapters 1-${input.lockedThrough} are locked)\n${JSON.stringify(input.outline, null, 2)}`,
    `# Locked chapter summaries\n${input.lockedSummaries.map((s) => `## Chapter ${s.number}\n${s.summary}`).join('\n\n') || '(none)'}`,
    `# Open promises\n${input.openPromises.map((p) => `- ${p.description} (pay off in chapters ${p.from}-${p.to})`).join('\n') || '(none)'}`,
    `# Drift the author adopted\n${input.driftAdoptions.map((d) => `- Chapter ${d.chapter} (${d.kind}): ${d.description} Adopted: ${d.adopted}`).join('\n') || '(none)'}`,
    `# Character arcs\n${input.arcs.map((a) => `- ${a.character}: from "${a.arcStart}" to "${a.arcEnd}". Checkpoints: ${a.checkpoints.map((c) => `ch ${c.chapter} ${c.met ? '(met)' : '(not yet)'} ${c.description}`).join('; ') || '(none)'}`).join('\n') || '(none)'}`,
    `# Your task\nPropose changes to chapters ${input.lockedThrough + 1}-${input.bible.spine.chapterCount} only where needed.`,
  ].join('\n\n');

  return runStructuredAgent(ctx, {
    agent: 'replanner',
    prompt: loadPrompt('replanner'),
    tier: 'strong',
    messages: [{ role: 'user', content }],
    schema: replanOutputSchema,
    maxTokens: 32000,
    check: (out) => {
      const problems = out.changes.flatMap((c) =>
        replanChangeProblems(
          input.outline.find((o) => o.number === c.chapter),
          c,
          input.lockedThrough,
        ),
      );
      if (problems.length) return problems;
      return validateOutline(applyReplan(input.outline, out.changes), input.bible.spine).map(
        (p) => `after your changes: ${p}`,
      );
    },
  });
}

export interface BookReviewerInput {
  bible: BibleContent;
  chapters: { number: number; title: string; summary: string; wordCount: number }[];
  promises: { description: string; status: string; plantedChapter: number; to: number }[];
  arcs: ArcStatus[];
}

export async function runBookReviewer(
  ctx: AgentContext,
  input: BookReviewerInput,
): Promise<BookReviewOutput> {
  const content = [
    `# Spine\n${JSON.stringify(input.bible.spine, null, 2)}`,
    `# Chapters\n${input.chapters.map((c) => `## Chapter ${c.number}: ${c.title} (${c.wordCount} words)\n${c.summary}`).join('\n\n')}`,
    `# Promise registry\n${input.promises.map((p) => `- [${p.status}] ${p.description} (planted ch ${p.plantedChapter}, due by ch ${p.to})`).join('\n') || '(empty)'}`,
    `# Character arcs\n${input.arcs.map((a) => `- ${a.character}: from "${a.arcStart}" to "${a.arcEnd}". Checkpoints: ${a.checkpoints.map((c) => `ch ${c.chapter} ${c.met ? '(met)' : '(not met)'} ${c.description}`).join('; ') || '(none)'}`).join('\n') || '(none)'}`,
  ].join('\n\n');
  const numbers = new Set(input.chapters.map((c) => c.number));
  return runStructuredAgent(ctx, {
    agent: 'book_reviewer',
    prompt: loadPrompt('book-reviewer'),
    tier: 'strong',
    messages: [{ role: 'user', content }],
    schema: bookReviewOutputSchema,
    maxTokens: 16000,
    check: (out) =>
      out.issues
        .filter((i) => i.chapter !== null && !numbers.has(i.chapter))
        .map((i) => `issues: chapter ${i.chapter} does not exist`),
  });
}
