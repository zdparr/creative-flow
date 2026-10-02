/**
 * Job names from the spec's jobs table. The spec's chapter.lockFinalize is folded into the lock
 * transaction itself (the summary comes from the cohesion job), so it has no job of its own.
 */
export const JOB_TYPES = [
  'outline.generate',
  'chapter.novelize',
  'chapter.cohesion',
  'chapter.deepen',
  'outline.replan',
  'character.draftCard',
  'book.review',
  'book.export',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** One BullMQ queue; the job type is the job name, so the worker needs a single consumer. */
export const QUEUE_NAME = 'storyforge';

/** Retry policy for API errors and rate limits: 3 attempts with exponential backoff. */
export const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 },
} as const;
