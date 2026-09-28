import type { JobType, LlmCallLog } from '@storyforge/core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { jobs, llmCalls } from '../schema.js';

export type JobRow = typeof jobs.$inferSelect;
export type JobRepo = ReturnType<typeof createJobRepo>;

/** The jobs table mirrors queue state so the UI can show progress without reading Redis. */
export function createJobRepo(db: Db) {
  return {
    async create(
      projectId: string,
      type: JobType,
      input: Record<string, unknown>,
    ): Promise<JobRow> {
      const [row] = await db.insert(jobs).values({ projectId, type, input }).returning();
      return row!;
    },

    async get(id: string): Promise<JobRow | null> {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
      return row ?? null;
    },

    /** The newest queued or running job of this type, used to make repeat requests idempotent. */
    async findActive(projectId: string, type: JobType): Promise<JobRow | null> {
      const [row] = await db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.projectId, projectId),
            eq(jobs.type, type),
            inArray(jobs.status, ['queued', 'running']),
          ),
        )
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      return row ?? null;
    },

    async latest(projectId: string, type: JobType): Promise<JobRow | null> {
      const [row] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, projectId), eq(jobs.type, type)))
        .orderBy(desc(jobs.createdAt))
        .limit(1);
      return row ?? null;
    },

    async markRunning(id: string, attempts: number): Promise<void> {
      await db
        .update(jobs)
        .set({ status: 'running', attempts, error: null })
        .where(eq(jobs.id, id));
    },

    async markSucceeded(id: string, resultRef: string): Promise<void> {
      await db.update(jobs).set({ status: 'succeeded', resultRef }).where(eq(jobs.id, id));
    },

    async markFailed(id: string, error: string): Promise<void> {
      await db.update(jobs).set({ status: 'failed', error }).where(eq(jobs.id, id));
    },

    /** Back to queued between retries, keeping the last error visible. */
    async markRetrying(id: string, error: string): Promise<void> {
      await db.update(jobs).set({ status: 'queued', error }).where(eq(jobs.id, id));
    },
  };
}

export function createLlmCallRepo(db: Db) {
  return {
    async record(
      projectId: string,
      log: LlmCallLog,
      refs: { chapterId?: string; jobId?: string } = {},
    ): Promise<void> {
      await db.insert(llmCalls).values({
        projectId,
        agent: log.agent,
        promptVersion: log.promptVersion,
        model: log.model,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        cachedTokens: log.cachedTokens,
        costUsd: log.costUsd.toFixed(6),
        chapterId: refs.chapterId,
        jobId: refs.jobId,
      });
    },

    listForProject(projectId: string) {
      return db.select().from(llmCalls).where(eq(llmCalls.projectId, projectId));
    },
  };
}
