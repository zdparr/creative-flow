import { AgentOutputError } from '@storyforge/core';
import type { JobRepo } from '@storyforge/db';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { type QueueJob, createProcessor } from './processor.js';

function fakeJobs() {
  return {
    markRunning: vi.fn(async () => {}),
    markSucceeded: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    markRetrying: vi.fn(async () => {}),
  };
}

const job = (overrides: Partial<QueueJob> = {}): QueueJob => ({
  id: 'job-1',
  name: 'outline.generate',
  data: { projectId: 'p1' },
  attemptsMade: 0,
  opts: { attempts: 3 },
  ...overrides,
});

describe('createProcessor', () => {
  it('rejects unknown job types permanently', async () => {
    const run = createProcessor({}, fakeJobs() as unknown as JobRepo);
    await expect(run(job({ name: 'nope' }))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('marks a successful job with its result', async () => {
    const jobs = fakeJobs();
    const run = createProcessor(
      { 'outline.generate': async () => 'outline-9' },
      jobs as unknown as JobRepo,
    );
    await expect(run(job())).resolves.toBe('outline-9');
    expect(jobs.markRunning).toHaveBeenCalledWith('job-1', 1);
    expect(jobs.markSucceeded).toHaveBeenCalledWith('job-1', 'outline-9');
  });

  it('fails invalid model output without retrying', async () => {
    const jobs = fakeJobs();
    const run = createProcessor(
      {
        'outline.generate': async () => {
          throw new AgentOutputError('outliner', ['bad']);
        },
      },
      jobs as unknown as JobRepo,
    );
    await expect(run(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(jobs.markFailed).toHaveBeenCalled();
  });

  it('leaves transient errors for BullMQ to retry until attempts run out', async () => {
    const jobs = fakeJobs();
    const boom = async () => {
      throw new Error('529 overloaded');
    };
    const run = createProcessor({ 'outline.generate': boom }, jobs as unknown as JobRepo);
    await expect(run(job({ attemptsMade: 0 }))).rejects.toThrow('overloaded');
    expect(jobs.markRetrying).toHaveBeenCalledWith('job-1', '529 overloaded');
    await expect(run(job({ attemptsMade: 2 }))).rejects.toThrow('overloaded');
    expect(jobs.markFailed).toHaveBeenCalledWith('job-1', '529 overloaded');
  });
});
