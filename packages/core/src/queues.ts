/** Job names from the spec's jobs table. Processors arrive in their build phases. */
export const JOB_TYPES = [
  'outline.generate',
  'chapter.novelize',
  'chapter.cohesion',
  'chapter.lockFinalize',
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
