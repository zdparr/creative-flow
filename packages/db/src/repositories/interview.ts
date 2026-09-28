import { ConflictError, type InterviewAnswer, type InterviewQuestion } from '@storyforge/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.js';
import { interviewRounds } from '../schema.js';

export type InterviewRound = typeof interviewRounds.$inferSelect;

export function createInterviewRepo(db: Db) {
  return {
    list(projectId: string): Promise<InterviewRound[]> {
      return db
        .select()
        .from(interviewRounds)
        .where(eq(interviewRounds.projectId, projectId))
        .orderBy(asc(interviewRounds.roundNo));
    },

    async add(
      projectId: string,
      roundNo: number,
      questions: InterviewQuestion[],
    ): Promise<InterviewRound> {
      const [row] = await db
        .insert(interviewRounds)
        .values({ projectId, roundNo, questions })
        .returning();
      return row!;
    },

    /** Records answers once; a round that already has answers is rejected. */
    async answer(projectId: string, roundId: string, answers: InterviewAnswer[]): Promise<void> {
      const updated = await db
        .update(interviewRounds)
        .set({ answers })
        .where(
          and(
            eq(interviewRounds.id, roundId),
            eq(interviewRounds.projectId, projectId),
            isNull(interviewRounds.answers),
          ),
        )
        .returning({ id: interviewRounds.id });
      if (updated.length === 0) throw new ConflictError('That round is already answered');
    },
  };
}
