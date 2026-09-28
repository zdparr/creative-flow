import { z } from 'zod';
import { ISSUE_SEVERITIES } from './cohesion.js';
import { type OutlineChapter, outlineChapterSchema } from './outline.js';

export const replanOutputSchema = z.object({
  changes: z
    .array(
      z.object({
        chapter: z.number().int().describe('Number of a remaining (unlocked) chapter to change'),
        reason: z.string().describe('Why, citing what happened in the locked chapters'),
        after: outlineChapterSchema.describe('The full chapter plan as it should now read'),
      }),
    )
    .describe('Only chapters that need to change; an empty list is a valid answer'),
});
export type ReplanOutput = z.infer<typeof replanOutputSchema>;

/** One proposed change in a stored re-plan diff; the author accepts or rejects each. */
export interface ReplanItem {
  id: string;
  chapter: number;
  reason: string;
  before: OutlineChapter;
  after: OutlineChapter;
  decision: 'accepted' | 'rejected' | null;
}

export const BOOK_ISSUE_CATEGORIES = [
  'pacing',
  'repetition',
  'theme_drift',
  'dropped_thread',
  'other',
] as const;

export const bookReviewOutputSchema = z.object({
  summary: z.string().describe('Two or three paragraphs: how the book works as a whole'),
  issues: z.array(
    z.object({
      chapter: z.number().int().nullable().describe('The chapter to revise, or null if book-wide'),
      category: z.enum(BOOK_ISSUE_CATEGORIES),
      severity: z.enum(ISSUE_SEVERITIES),
      description: z.string(),
      suggestion: z.string().describe('What the author could change'),
    }),
  ),
});
export type BookReviewOutput = z.infer<typeof bookReviewOutputSchema>;
export type BookIssue = BookReviewOutput['issues'][number];
