import { JOB_TYPES, type JobType } from '@storyforge/core';

export type JobHandler = (data: unknown) => Promise<unknown>;

/** Handlers are registered as each build phase lands; Phase 1 has none. */
export const handlers: Partial<Record<JobType, JobHandler>> = {};

export async function processJob(name: string, data: unknown): Promise<unknown> {
  if (!(JOB_TYPES as readonly string[]).includes(name)) {
    throw new Error(`Unknown job type: ${name}`);
  }
  const handler = handlers[name as JobType];
  if (!handler) throw new Error(`No handler registered for ${name}`);
  return handler(data);
}
