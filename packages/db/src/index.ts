import type { Db } from './client.js';
import { createBibleRepo } from './repositories/bibles.js';
import { createInterviewRepo } from './repositories/interview.js';
import { createJobRepo, createLlmCallRepo } from './repositories/jobs.js';
import { createOutlineRepo } from './repositories/outlines.js';
import { createProjectRepo } from './repositories/projects.js';
import { createUserRepo } from './repositories/users.js';

export * from './client.js';
export * from './repositories/bibles.js';
export * from './repositories/interview.js';
export * from './repositories/jobs.js';
export * from './repositories/outlines.js';
export * from './repositories/projects.js';
export * from './repositories/users.js';
export * as schema from './schema.js';

export function createRepos(db: Db) {
  return {
    users: createUserRepo(db),
    projects: createProjectRepo(db),
    interview: createInterviewRepo(db),
    bibles: createBibleRepo(db),
    outlines: createOutlineRepo(db),
    jobs: createJobRepo(db),
    llmCalls: createLlmCallRepo(db),
  };
}
export type Repos = ReturnType<typeof createRepos>;

/** True when a query failed on a unique constraint (Postgres 23505), however the driver wrapped it. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

/** Runs `fn` with repositories bound to one transaction. */
export function inTransaction<T>(db: Db, fn: (repos: Repos) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(createRepos(tx as unknown as Db)));
}
