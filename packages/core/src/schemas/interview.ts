import { z } from 'zod';
import { bibleContentSchema } from './bible.js';

export const MIN_INTERVIEW_ROUNDS = 3;
export const MAX_INTERVIEW_ROUNDS = 5;

export const interviewQuestionSchema = z.object({
  id: z.string().describe('Short stable id, unique within the round, e.g. "q1"'),
  topic: z
    .string()
    .describe('genre, tone, pov, protagonist, antagonist, theme, ending, length, ...'),
  question: z.string(),
});
export type InterviewQuestion = z.infer<typeof interviewQuestionSchema>;

export const ANSWER_KINDS = ['answer', 'skip', 'you_decide'] as const;

export const interviewAnswerSchema = z.object({
  questionId: z.string(),
  kind: z.enum(ANSWER_KINDS),
  text: z.string().default(''),
});
export type InterviewAnswer = z.infer<typeof interviewAnswerSchema>;

export const interviewAnswersSchema = z.array(interviewAnswerSchema);

export const interviewerOutputSchema = z.object({
  kind: z.enum(['questions', 'bible']),
  questions: z
    .array(interviewQuestionSchema)
    .describe('3-5 questions when kind is "questions", else empty'),
  bible: bibleContentSchema.nullable().describe('The draft bible when kind is "bible", else null'),
});
export type InterviewerOutput = z.infer<typeof interviewerOutputSchema>;
