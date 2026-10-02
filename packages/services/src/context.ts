import type { AgentContext, JobType, LlmClient } from '@storyforge/core';
import { type Db, type Repos, createRepos } from '@storyforge/db';
import type { FileStore } from './files.js';

/** Hands a job to the queue. The job row id is the queue job id, so re-enqueueing is idempotent. */
export type Enqueue = (job: {
  id: string;
  type: JobType;
  data: Record<string, unknown>;
}) => Promise<void>;

export interface ServiceDeps {
  db: Db;
  llm: LlmClient;
  enqueue: Enqueue;
  /** Export storage (S3); exports are kept in Postgres when absent. */
  files?: FileStore;
  /** Run the deepening pass after each chapter draft (default on). */
  deepen?: boolean;
}

export interface ServiceContext extends ServiceDeps {
  repos: Repos;
  /** Agent context that logs every model call's cost against the project (and job). */
  agentContext(projectId: string, refs?: { jobId?: string; chapterId?: string }): AgentContext;
}

export function createServiceContext(deps: ServiceDeps): ServiceContext {
  const repos = createRepos(deps.db);
  return {
    ...deps,
    repos,
    agentContext: (projectId, refs = {}) => ({
      llm: deps.llm,
      onCall: (log) => repos.llmCalls.record(projectId, log, refs),
    }),
  };
}
