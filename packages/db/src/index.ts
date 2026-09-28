import type { Db } from './client.js';
import { createBibleRepo } from './repositories/bibles.js';
import { createBookReviewRepo, createExportRepo, createReplanRepo } from './repositories/book.js';
import { createDraftRepo } from './repositories/drafts.js';
import { createInterviewRepo } from './repositories/interview.js';
import { createJobRepo, createLlmCallRepo } from './repositories/jobs.js';
import { createOutlineRepo } from './repositories/outlines.js';
import { createCharacterRepo } from './repositories/characters.js';
import {
  createCohesionRepo,
  createDriftRepo,
  createKnowledgeRepo,
  createLedgerRepo,
  createPromiseRepo,
  createSnapshotRepo,
} from './repositories/cohesion.js';
import { createChapterRepo, createPlayRepo } from './repositories/play.js';
import { createProjectRepo } from './repositories/projects.js';
import { createUserRepo } from './repositories/users.js';

export * from './client.js';
export * from './repositories/bibles.js';
export * from './repositories/book.js';
export * from './repositories/characters.js';
export * from './repositories/cohesion.js';
export * from './repositories/drafts.js';
export * from './repositories/interview.js';
export * from './repositories/jobs.js';
export * from './repositories/outlines.js';
export * from './repositories/play.js';
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
    chapters: createChapterRepo(db),
    play: createPlayRepo(db),
    characters: createCharacterRepo(db),
    drafts: createDraftRepo(db),
    cohesion: createCohesionRepo(db),
    ledger: createLedgerRepo(db),
    knowledge: createKnowledgeRepo(db),
    promises: createPromiseRepo(db),
    snapshots: createSnapshotRepo(db),
    drift: createDriftRepo(db),
    replan: createReplanRepo(db),
    bookReviews: createBookReviewRepo(db),
    exports: createExportRepo(db),
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
