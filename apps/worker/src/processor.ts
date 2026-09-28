import {
  AgentOutputError,
  ConflictError,
  GateError,
  JOB_TYPES,
  type JobType,
  LlmRefusalError,
  NotFoundError,
  describeLlmError,
} from '@storyforge/core';
import type { JobRepo } from '@storyforge/db';
import { UnrecoverableError } from 'bullmq';

export interface QueueJob {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  opts: { attempts?: number };
}

/** Returns the result reference stored on the jobs row (e.g. the new outline id). */
export type JobHandler = (jobId: string, data: unknown) => Promise<string>;
export type Handlers = Partial<Record<JobType, JobHandler>>;

/**
 * Failures a retry cannot fix: invalid model output (already retried once), refusals, bad
 * state, and non-transient API errors such as a bad request or an invalid key.
 */
function isPermanent(err: unknown): boolean {
  const llmError = describeLlmError(err);
  if (llmError) return !llmError.transient;
  return (
    err instanceof AgentOutputError ||
    err instanceof LlmRefusalError ||
    err instanceof ConflictError ||
    err instanceof GateError ||
    err instanceof NotFoundError
  );
}

/**
 * Runs a queue job and mirrors its state into the jobs table so the UI can show progress.
 * Transient errors (API errors, rate limits) are rethrown for BullMQ to retry with backoff.
 */
export function createProcessor(handlers: Handlers, jobs: JobRepo) {
  return async (job: QueueJob): Promise<string> => {
    if (!(JOB_TYPES as readonly string[]).includes(job.name)) {
      throw new UnrecoverableError(`Unknown job type: ${job.name}`);
    }
    const handler = handlers[job.name as JobType];
    if (!handler) throw new UnrecoverableError(`No handler registered for ${job.name}`);
    if (!job.id) throw new UnrecoverableError('Job has no id');

    const attempt = job.attemptsMade + 1;
    await jobs.markRunning(job.id, attempt);
    try {
      const resultRef = await handler(job.id, job.data);
      await jobs.markSucceeded(job.id, resultRef);
      return resultRef;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isPermanent(err)) {
        await jobs.markFailed(job.id, message);
        throw new UnrecoverableError(message);
      }
      if (attempt >= (job.opts.attempts ?? 1)) await jobs.markFailed(job.id, message);
      else await jobs.markRetrying(job.id, message);
      throw err;
    }
  };
}
