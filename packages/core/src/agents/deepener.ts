import { z } from 'zod';
import {
  type CharacterCard,
  type ContextCommitment,
  renderCard,
  renderCommitment,
} from '../context/buildContext.js';
import { proseBlocks } from '../export/chapterDocx.js';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { withProseStyle } from '../prose/houseStyle.js';
import { type Retention, retention } from '../prose/retention.js';
import { draftParagraphs, proseProblems, wordCount } from '../prose/rules.js';
import { loadPrompt } from '../prompts/loader.js';
import type { BibleContent } from '../schemas/bible.js';
import type { OutlineChapter } from '../schemas/outline.js';
import { type NovelizerEvent, styleGuideSection } from './novelizer.js';

// The deepening pass adds craft layers (interiority, consequence, continuity) to a drafted
// chapter without rewriting it. These limits keep it additive. They are calibrated on a human
// editor's pass over a test chapter, which kept 99.5% of the draft's words in order, grew it by
// 11%, and kept 78% of the one paragraph it restructured around a pivotal moment.
export const DEEPEN_TARGET_GROWTH = { min: 0.1, max: 0.15 };
export const DEEPEN_MAX_GROWTH = 0.18;
export const DEEPEN_MIN_RETAINED = 0.98;
export const DEEPEN_MIN_PARAGRAPH_RETAINED = 0.75;
export const DEEPEN_MAX_PIVOTAL = 3;

export const deepenerOutputSchema = z.object({
  pivotalMoments: z
    .array(
      z.object({
        paragraph: z.number().int().describe('1-based paragraph where the moment begins'),
        moment: z.string().describe('A few words naming the moment'),
      }),
    )
    .describe('The 1-3 pivotal moments you slowed down'),
  edits: z
    .array(
      z.object({
        paragraph: z.number().int().describe('1-based number of the paragraph you add to'),
        text: z
          .string()
          .describe('The paragraph in full with your additions; blank lines split it in several'),
      }),
    )
    .describe('Existing paragraphs you change; most paragraphs should not appear here'),
  inserts: z
    .array(
      z.object({
        after: z
          .number()
          .int()
          .describe('The paragraph this follows (0 for the start of the chapter)'),
        text: z.string().describe('New paragraphs, separated by blank lines'),
      }),
    )
    .describe('New paragraphs placed between existing ones'),
});
export type DeepenerOutput = z.infer<typeof deepenerOutputSchema>;

export interface DeepenerInput {
  bible: BibleContent;
  chapterNumber: number;
  plan: OutlineChapter;
  /** The chronicle the draft was written from; the pass may not add events beyond it. */
  events: NovelizerEvent[];
  cards: CharacterCard[];
  /** Secrets and instructions in force for the chapter's cast, including any given in its play. */
  commitments: ContextCommitment[];
  /** Open mysteries and setups the chapter can close on. */
  threads: string[];
  /** The drafted chapter. */
  prose: string;
}

export interface DeepenResult {
  prose: string;
  pivotalMoments: DeepenerOutput['pivotalMoments'];
  retention: Retention;
  /** Draft paragraphs changed, and new paragraph groups added. */
  edited: number;
  inserted: number;
}

const paragraphsOf = (text: string) =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

const SCENE_BREAK_LINE = /^\s*(#|\*\s*\*\s*\*)\s*$/m;

/**
 * Applies the pass to the prose: edited paragraphs replaced (possibly by several), inserts
 * placed after the paragraph they follow. Scene breaks stay where they were.
 */
export function applyDeepening(prose: string, out: Pick<DeepenerOutput, 'edits' | 'inserts'>) {
  const edits = new Map(out.edits.map((e) => [e.paragraph, paragraphsOf(e.text)]));
  const inserts = new Map<number, string[]>();
  for (const i of out.inserts)
    inserts.set(i.after, [...(inserts.get(i.after) ?? []), ...paragraphsOf(i.text)]);
  const blocks: string[] = [...(inserts.get(0) ?? [])];
  let n = 0;
  for (const b of proseBlocks(prose)) {
    if (b.kind === 'break') {
      blocks.push('#');
      continue;
    }
    n += 1;
    blocks.push(...(edits.get(n) ?? [b.text]), ...(inserts.get(n) ?? []));
  }
  return blocks.join('\n\n');
}

/** The draft with numbered paragraphs and visible scene breaks, so scene endings can be found. */
function numberedWithBreaks(prose: string): string {
  let n = 0;
  return proseBlocks(prose)
    .map((b) => (b.kind === 'break' ? '# (scene break)' : `[${++n}] ${b.text}`))
    .join('\n\n');
}

export function buildDeepenerPrompt(input: DeepenerInput): string {
  const words = wordCount(input.prose);
  const pct = (x: number) => Math.round(words * x);
  return [
    styleGuideSection(input.bible),
    `# Chapter ${input.chapterNumber}: ${input.plan.title}\nPurpose: ${input.plan.purpose}\nRequired beats:\n${input.plan.requiredBeats.map((b) => `- ${b.pivotal ? '(PIVOTAL) ' : ''}${b.description}`).join('\n')}`,
    `# Characters in this chapter\n${input.cards.map(renderCard).join('\n') || '(none)'}`,
    `# Chronicle (what happened; add no events beyond these)\n${input.events
      .map((e, i) =>
        [
          `${i + 1}. ${e.pivotal ? '(PIVOTAL) ' : ''}${e.summary}`,
          e.interiorityNote ? `   Interiority (the author's note): ${e.interiorityNote}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n')}`,
    `# Secrets and instructions in force\n${input.commitments.map((c) => `- ${renderCommitment(c)}`).join('\n') || '(none)'}`,
    `# Threads the chapter can close on\n${input.threads.map((t) => `- ${t}`).join('\n') || '(none listed: use the chapter’s own central image or question)'}`,
    `# Length budget\nThe draft is ${words} words. Add about ${pct(DEEPEN_TARGET_GROWTH.min)}-${pct(DEEPEN_TARGET_GROWTH.max)} words in all, and never more than ${pct(DEEPEN_MAX_GROWTH)}.`,
    `# The draft (numbered paragraphs)\n${numberedWithBreaks(input.prose)}`,
    '# Your task\nMake the deepening pass. Add only what the craft layers call for, keep every existing sentence, and answer with the edits and inserts.',
  ].join('\n\n');
}

/**
 * The deepening pass: additive craft edits to a drafted chapter. An answer that rewrites the
 * draft, runs past the length cap, or breaks the house style retries once with the problems
 * listed; after that it throws, and the caller keeps the undeepened draft.
 */
export async function runDeepener(ctx: AgentContext, input: DeepenerInput): Promise<DeepenResult> {
  const paragraphs = draftParagraphs(input.prose);
  const banned = input.bible.styleGuide.bannedPhrases;
  const out = await runStructuredAgent(ctx, {
    agent: 'deepener',
    prompt: withProseStyle(loadPrompt('deepener')),
    tier: 'strong',
    messages: [{ role: 'user', content: buildDeepenerPrompt(input) }],
    schema: deepenerOutputSchema,
    maxTokens: 16000,
    check: (o) => {
      const inRange = (n: number) => n >= 1 && n <= paragraphs.length;
      const seen = new Set<number>();
      const problems = [
        ...(o.pivotalMoments.length > DEEPEN_MAX_PIVOTAL
          ? [`pivotalMoments: slow down at most ${DEEPEN_MAX_PIVOTAL} moments`]
          : []),
        ...o.edits.flatMap((e) => {
          if (!inRange(e.paragraph)) {
            return [`edits: paragraph ${e.paragraph} does not exist (1-${paragraphs.length})`];
          }
          if (seen.has(e.paragraph)) return [`edits: paragraph ${e.paragraph} is edited twice`];
          seen.add(e.paragraph);
          const kept = retention(paragraphs[e.paragraph - 1]!, e.text).retained;
          return kept < DEEPEN_MIN_PARAGRAPH_RETAINED
            ? [
                `edits: paragraph ${e.paragraph} rewrites the draft (keeps ${Math.round(kept * 100)}% of its words); keep its sentences and only add to them`,
              ]
            : [];
        }),
        ...o.inserts
          .filter((i) => i.after < 0 || i.after > paragraphs.length)
          .map((i) => `inserts: after ${i.after} is not a paragraph (0-${paragraphs.length})`),
        ...[...o.edits, ...o.inserts]
          .filter((x) => SCENE_BREAK_LINE.test(x.text))
          .map(() => 'Do not add or remove scene breaks'),
        ...[...o.edits, ...o.inserts].flatMap((x) => proseProblems(x.text, banned)),
      ];
      if (problems.length) return problems;

      const prose = applyDeepening(input.prose, o);
      const r = retention(input.prose, prose);
      return [
        ...(r.retained < DEEPEN_MIN_RETAINED
          ? [
              `The pass keeps only ${Math.round(r.retained * 1000) / 10}% of the draft's words; keep at least ${DEEPEN_MIN_RETAINED * 100}% by adding rather than rewriting`,
            ]
          : []),
        ...(r.growth > DEEPEN_MAX_GROWTH
          ? [
              `The pass grows the chapter by ${Math.round(r.growth * 100)}%; cut additions to stay under ${DEEPEN_MAX_GROWTH * 100}%`,
            ]
          : []),
      ];
    },
  });

  const prose = applyDeepening(input.prose, out);
  return {
    prose,
    retention: retention(input.prose, prose),
    pivotalMoments: out.pivotalMoments,
    edited: out.edits.length,
    inserted: out.inserts.length,
  };
}
