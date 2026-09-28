import { z } from 'zod';
import { bibleContentSchema } from './bible.js';

export const MIN_INTERVIEW_ROUNDS = 3;
export const MAX_INTERVIEW_ROUNDS = 5;

export const interviewQuestionSchema = z.object({
  id: z.string(),
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

// The model writes only topic and question; the server assigns ids (q1, q2, ...).
const generatedQuestionSchema = interviewQuestionSchema.omit({ id: true });

export const interviewerOutputSchema = z.object({
  kind: z.enum(['questions', 'bible']),
  questions: z
    .array(generatedQuestionSchema)
    .describe('3-5 questions when kind is "questions", else empty'),
  bible: bibleContentSchema.nullable().describe('The draft bible when kind is "bible", else null'),
});
export type InterviewerOutput = z.infer<typeof interviewerOutputSchema>;

/** An interviewer result with server-assigned question ids. */
export type InterviewStepResult = Omit<InterviewerOutput, 'questions'> & {
  questions: InterviewQuestion[];
};
