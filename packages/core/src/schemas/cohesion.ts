import { z } from 'zod';
import { PROMISE_TYPES } from '../domain/status.js';

export const ISSUE_SEVERITIES = ['blocker', 'warning', 'note'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_CATEGORIES = [
  'contradiction',
  'knowledge',
  'principle',
  'promise',
  'arc',
  'theme',
  'style',
  'pacing',
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const cohesionIssueSchema = z.object({
  severity: z.enum(ISSUE_SEVERITIES),
  category: z.enum(ISSUE_CATEGORIES),
  paragraph: z
    .number()
    .int()
    .describe('1-based paragraph number in the draft where the problem is; 0 if chapter-wide'),
  description: z.string().describe('What is wrong, in one or two sentences'),
  evidence: z
    .string()
    .describe('The ledger fact, card field, knowledge entry, or registry entry it conflicts with'),
  suggestedFix: z.string().describe('A one-line fix the author can apply or ignore'),
});

export const criticOutputSchema = z.object({
  issues: z.array(cohesionIssueSchema),
  paidPromiseIds: z.array(z.string()).describe('Ids of open promises this draft clearly pays off'),
  promisesPlanted: z
    .array(
      z.object({
        description: z.string(),
        type: z.enum(PROMISE_TYPES),
        payoffChapter: z.number().int().describe('The last chapter by which it should pay off'),
      }),
    )
    .describe(
      'New setups this draft plants (planned or not) that are not already open promises; each becomes a registry entry at lock',
    ),
  checkpointsMet: z
    .array(z.object({ character: z.string(), chapter: z.number().int() }))
    .describe('Arc checkpoints due by this chapter that the draft clearly meets'),
  factCorrections: z
    .array(
      z.object({
        ref: z.string().describe('The fact ref, like "P3"'),
        corrected: z
          .string()
          .describe('The fact as this draft establishes it; empty if the draft drops it entirely'),
      }),
    )
    .default([])
    .describe(
      'Facts recorded during play that this draft changes or no longer contains; omit facts the draft keeps as they are',
    ),
  summary: z
    .string()
    .describe('A 300-500 word summary of the chapter as written, for later chapters to read'),
});
export type CriticOutput = z.infer<typeof criticOutputSchema>;
export type PlantedPromise = CriticOutput['promisesPlanted'][number];

/**
 * A fact recorded during play that the draft revised: the lock commits `corrected` in its
 * place, or nothing when `corrected` is empty. Keyed by the original statement.
 */
export interface FactCorrection {
  statement: string;
  corrected: string;
}

/** A stored issue: the critic's (or a rule's) finding with a stable id for waivers. */
export interface CohesionIssue extends z.infer<typeof cohesionIssueSchema> {
  id: string;
  source: 'critic' | 'rules';
}

export interface Waiver {
  issueId: string;
  reason: string;
  at: string;
}

/** Blockers that are not waived; the chapter cannot lock while any remain. */
export function openBlockers(issues: CohesionIssue[], waived: Waiver[]): CohesionIssue[] {
  const done = new Set(waived.map((w) => w.issueId));
  return issues.filter((i) => i.severity === 'blocker' && !done.has(i.id));
}
