import { proseBlocks } from '../export/chapterDocx.js';
import type { CohesionIssue } from '../schemas/cohesion.js';
import { dashViolations } from './houseStyle.js';

/** A draft's paragraphs, numbered from 1 in the review screen and the critic's report. */
export function draftParagraphs(prose: string): string[] {
  return proseBlocks(prose).flatMap((b) => (b.kind === 'para' ? [b.text] : []));
}

export const wordCount = (prose: string) => prose.split(/\s+/).filter(Boolean).length;

/** Banned phrases found in the text, case-insensitively. */
export function bannedPhrasesIn(text: string, banned: string[]): string[] {
  const lower = text.toLowerCase();
  return banned.filter((p) => p.trim() && lower.includes(p.trim().toLowerCase()));
}

/** Problems a prose agent should fix on retry: forbidden dashes and banned phrases. */
export function proseProblems(prose: string, banned: string[]): string[] {
  return [
    ...dashViolations(prose).map(
      (excerpt) =>
        `Dash outside cut-off speech in "…${excerpt}…"; rewrite with a comma, period, semicolon, colon, or parentheses.`,
    ),
    ...bannedPhrasesIn(prose, banned).map((p) => `Banned phrase used: "${p}".`),
  ];
}

export interface OverduePromise {
  id: string;
  description: string;
  /** Last chapter of its payoff window. */
  to: number;
}

/**
 * Checks that need no model: house-style dashes and banned phrases (warnings, per paragraph),
 * and open promises whose payoff window ends by this chapter without being paid (blockers).
 */
export function ruleIssues(input: {
  paragraphs: string[];
  bannedPhrases: string[];
  overdue: OverduePromise[];
}): Omit<CohesionIssue, 'id'>[] {
  const issues: Omit<CohesionIssue, 'id'>[] = [];
  input.paragraphs.forEach((text, i) => {
    for (const excerpt of dashViolations(text)) {
      issues.push({
        source: 'rules',
        severity: 'warning',
        category: 'style',
        paragraph: i + 1,
        description: `A dash outside cut-off speech: "…${excerpt}…"`,
        evidence: 'House style: em dashes only for speech that is cut off.',
        suggestedFix: 'Use a comma, period, semicolon, colon, or parentheses instead.',
      });
    }
    for (const phrase of bannedPhrasesIn(text, input.bannedPhrases)) {
      issues.push({
        source: 'rules',
        severity: 'warning',
        category: 'style',
        paragraph: i + 1,
        description: `Banned phrase: "${phrase}"`,
        evidence: 'Style guide banned phrases list.',
        suggestedFix: 'Rephrase this line.',
      });
    }
  });
  for (const p of input.overdue) {
    issues.push({
      source: 'rules',
      severity: 'blocker',
      category: 'promise',
      paragraph: 0,
      description: `An open promise reaches the end of its payoff window without being paid: "${p.description}"`,
      evidence: `Promise registry: open, pay off by chapter ${p.to}.`,
      suggestedFix: 'Pay it off in this chapter, or waive this and extend or drop the promise.',
    });
  }
  return issues;
}
