import { z } from 'zod';
import { ANCHOR_TYPES } from './bible.js';
import { PROMISE_TYPES } from '../domain/status.js';

export const requiredBeatSchema = z.object({
  id: z.string().describe('Stable id unique across the outline, e.g. "c3-b2"'),
  description: z.string(),
  pivotal: z
    .boolean()
    .optional()
    .describe(
      'True for the 1-3 beats where the chapter turns (a failure, discovery, confrontation, or decision); the prose slows down there',
    ),
});

export const arcMoveSchema = z.object({
  character: z.string(),
  change: z.string().describe('How this chapter moves their arc'),
});

export const plannedPromiseSchema = z.object({
  description: z.string(),
  type: z.enum(PROMISE_TYPES),
  payoffChapter: z.number().int().describe('Chapter where this promise should pay off'),
});

export const chapterPromisesSchema = z.object({
  planted: z.array(plannedPromiseSchema),
  paid: z.array(z.string()).describe('Descriptions of earlier promises paid off here'),
});
export type ChapterPromises = z.infer<typeof chapterPromisesSchema>;

export const outlineChapterSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  purpose: z.string(),
  requiredBeats: z.array(requiredBeatSchema),
  arcsMoved: z.array(arcMoveSchema),
  isAnchor: z.boolean(),
  anchorType: z.enum(ANCHOR_TYPES).nullable(),
  promises: chapterPromisesSchema,
});
export type OutlineChapter = z.infer<typeof outlineChapterSchema>;

export const outlinerOutputSchema = z.object({
  chapters: z.array(outlineChapterSchema),
});
export type OutlinerOutput = z.infer<typeof outlinerOutputSchema>;
