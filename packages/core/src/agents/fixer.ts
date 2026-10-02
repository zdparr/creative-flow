import { z } from 'zod';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { withHouseStyle } from '../prose/houseStyle.js';
import { proseProblems } from '../prose/rules.js';
import { loadPrompt } from '../prompts/loader.js';
import type { CohesionIssue } from '../schemas/cohesion.js';
import type { OutlineChapter } from '../schemas/outline.js';
import { type CriticInput, cohesionSections, numberedDraft } from './critic.js';

export const fixOutputSchema = z.object({
  edits: z
    .array(
      z.object({
        paragraph: z.number().int().describe('1-based number of the paragraph to replace'),
        text: z.string().describe('The full replacement paragraph'),
      }),
    )
    .describe('Only the paragraphs that change'),
  move: z
    .object({
      paragraphs: z
        .array(z.number().int())
        .describe('1-based numbers of the paragraphs to cut from this chapter'),
      scenes: z
        .array(z.number().int())
        .describe('Numbers of the played scenes that happen only in those paragraphs'),
      beat: z
        .string()
        .describe('The new required beat for the next chapter: what must now happen there'),
    })
    .nullable()
    .describe('Only when the fix is to move content to the next chapter; otherwise null'),
  skipped: z
    .array(
      z.object({
        problem: z.number().int().describe('The number of the problem left unfixed'),
        reason: z.string().describe('Why rewriting cannot fix it, in one sentence'),
      }),
    )
    .default([])
    .describe('Problems a rewrite of this draft cannot fix; empty when every problem is fixed'),
  explanation: z.string().describe('One or two sentences for the author: what changed and why'),
});
export type FixOutput = z.infer<typeof fixOutputSchema>;

export interface FixerScene {
  summary: string;
  /** Ids of this chapter's required beats the scene hits. */
  beats: string[];
}

export interface FixerInput {
  /** The same context the cohesion critic checks against, including the draft. */
  context: CriticInput;
  /** The issues to fix together in one revision; at least one. */
  issues: CohesionIssue[];
  /** The report's other open issues, which the fix must not make worse. */
  otherIssues: CohesionIssue[];
  /** The scenes played for this chapter, in order. */
  scenes: FixerScene[];
  /** The next chapter's plan when content can move there; null when it cannot. Ignored for several issues. */
  nextChapter: OutlineChapter | null;
}

const describe = (i: CohesionIssue) =>
  `- [${i.severity} ${i.category}, ${i.paragraph > 0 ? `paragraph ${i.paragraph}` : 'whole chapter'}] ${i.description}`;

function nextChapterSection(next: OutlineChapter | null): string {
  if (!next) {
    return '# The next chapter\n(Content cannot move: this is the last chapter, or the next chapter is already written. Set move to null.)';
  }
  return `# The next chapter (content may move here)\nChapter ${next.number}: ${next.title}\nPurpose: ${next.purpose}\nRequired beats:\n${next.requiredBeats.map((b) => `- ${b.description}`).join('\n') || '(none)'}`;
}

const unique = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);

const problem = (i: CohesionIssue) =>
  `Severity: ${i.severity}\nCategory: ${i.category}\nWhere: ${i.paragraph > 0 ? `paragraph ${i.paragraph}` : 'the whole chapter'}\nWhat is wrong: ${i.description}\nEvidence: ${i.evidence}\nSuggested fix: ${i.suggestedFix}`;

function problemsSection(issues: CohesionIssue[]): string {
  if (issues.length === 1) return `# The problem to fix\n${problem(issues[0]!)}`;
  return `# The problems to fix (all of them, in one revision)\n${issues.map((i, n) => `## Problem ${n + 1}\n${problem(i)}`).join('\n\n')}`;
}

/**
 * Proposes replacement paragraphs that fix one or several cohesion issues in one revision, for
 * the author to approve. It revises against everything the critic checks, so a fix does not
 * create a new problem. For a single issue whose fix is to move content to the next chapter, it
 * names what to cut and the beat to add.
 */
export async function runFixer(ctx: AgentContext, input: FixerInput): Promise<FixOutput> {
  const { issues, context, scenes } = input;
  if (issues.length === 0) throw new Error('runFixer needs at least one issue');
  // Moving content is a structural change the author decides one issue at a time.
  const nextChapter = issues.length === 1 ? input.nextChapter : null;
  const { paragraphs } = context;
  const content = [
    ...cohesionSections(context),
    `# Scenes played in this chapter (numbered)\n${scenes.map((s, i) => `[${i + 1}] ${s.summary}${s.beats.length ? ` (hits beats: ${s.beats.join(', ')})` : ''}`).join('\n') || '(none)'}`,
    nextChapterSection(nextChapter),
    numberedDraft(paragraphs),
    problemsSection(issues),
    `# Other open issues (do not make these worse or add new ones)\n${input.otherIssues.map(describe).join('\n') || '(none)'}`,
    issues.length === 1
      ? '# Your task\nRevise only the paragraphs needed to fix the problem, or move content to the next chapter if that is the fix. Before answering, check your revision against every card, knowledge entry, ledger fact, promise, and required beat above.'
      : '# Your task\nRevise only the paragraphs needed to fix every problem above, in one consistent revision: where two problems touch the same paragraph, give one replacement that fixes both. List in `skipped` any problem a rewrite cannot fix. Before answering, check your revision against every card, knowledge entry, ledger fact, promise, and required beat above.',
  ].join('\n\n');

  const banned = context.bible.styleGuide.bannedPhrases;
  const inRange = (n: number, count: number) => n >= 1 && n <= count;
  const out = await runStructuredAgent(ctx, {
    agent: 'fixer',
    prompt: withHouseStyle(loadPrompt('fixer')),
    tier: 'strong',
    messages: [{ role: 'user', content }],
    schema: fixOutputSchema,
    maxTokens: 16000,
    check: (o) => {
      const moved = new Set(o.move?.paragraphs ?? []);
      return [
        ...(o.edits.length === 0 && !o.move && o.skipped.length < issues.length
          ? ['edits: change at least one paragraph, or move content']
          : []),
        ...o.skipped
          .filter((sk) => sk.problem < 1 || sk.problem > issues.length)
          .map((sk) => `skipped: problem ${sk.problem} does not exist (1-${issues.length})`),
        ...o.edits
          .filter((e) => !inRange(e.paragraph, paragraphs.length))
          .map((e) => `edits: paragraph ${e.paragraph} does not exist (1-${paragraphs.length})`),
        ...o.edits
          .filter((e) => moved.has(e.paragraph))
          .map(
            (e) => `edits: paragraph ${e.paragraph} is being moved, so it cannot also be edited`,
          ),
        ...o.edits.flatMap((e) =>
          proseProblems(e.text, banned).map((p) => `paragraph ${e.paragraph}: ${p}`),
        ),
        ...(o.move ? moveProblems(o.move) : []),
      ];
    },
  });

  function moveProblems(move: NonNullable<FixOutput['move']>): string[] {
    if (!nextChapter) return ['move: content cannot move to the next chapter; set move to null'];
    const cut = unique(move.paragraphs);
    return [
      ...(cut.length === 0 ? ['move: name at least one paragraph to cut'] : []),
      ...(cut.length >= paragraphs.length ? ['move: the chapter must keep some paragraphs'] : []),
      ...cut
        .filter((n) => !inRange(n, paragraphs.length))
        .map((n) => `move: paragraph ${n} does not exist (1-${paragraphs.length})`),
      ...move.scenes
        .filter((n) => !inRange(n, scenes.length))
        .map((n) => `move: scene ${n} does not exist (1-${scenes.length})`),
      ...(move.beat.trim() ? [] : ['move: describe the beat for the next chapter']),
      ...proseProblems(move.beat, banned).map((p) => `move beat: ${p}`),
    ];
  }

  // One paragraph per edit, keeping numbering stable; the last edit to a paragraph wins.
  const byParagraph = new Map(
    out.edits.map((e) => [e.paragraph, e.text.replace(/\s*\n\s*/g, ' ').trim()]),
  );
  return {
    explanation: out.explanation,
    skipped: [...new Map(out.skipped.map((sk) => [sk.problem, sk])).values()].sort(
      (a, b) => a.problem - b.problem,
    ),
    edits: [...byParagraph]
      .sort(([a], [b]) => a - b)
      .map(([paragraph, text]) => ({ paragraph, text })),
    move: out.move && {
      paragraphs: unique(out.move.paragraphs),
      scenes: unique(out.move.scenes),
      beat: out.move.beat.trim(),
    },
  };
}
