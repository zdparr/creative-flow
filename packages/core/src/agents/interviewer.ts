import { validateSpine } from '../domain/validation.js';
import { type AgentContext, runStructuredAgent } from '../llm/runAgent.js';
import { loadPrompt } from '../prompts/loader.js';
import type { z } from 'zod';
import {
  type BibleContent,
  type BibleSection,
  type Spine,
  bibleSectionSchemas,
} from '../schemas/bible.js';
import {
  type InterviewAnswer,
  type InterviewQuestion,
  type InterviewStepResult,
  MAX_INTERVIEW_ROUNDS,
  MIN_INTERVIEW_ROUNDS,
  interviewerOutputSchema,
} from '../schemas/interview.js';

export interface AnsweredRound {
  roundNo: number;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
}

export interface InterviewerInput {
  pitch: string;
  rounds: AnsweredRound[];
}

/** Whether the interviewer must ask, must draft, or may choose, given rounds answered so far. */
export function interviewStage(answeredRounds: number): 'ask' | 'draft' | 'either' {
  if (answeredRounds < MIN_INTERVIEW_ROUNDS) return 'ask';
  if (answeredRounds >= MAX_INTERVIEW_ROUNDS) return 'draft';
  return 'either';
}

function renderTranscript(rounds: AnsweredRound[]): string {
  if (rounds.length === 0) return '(No rounds yet.)';
  return rounds
    .map((round) => {
      const lines = round.questions.map((q) => {
        const a = round.answers.find((x) => x.questionId === q.id);
        const answer =
          !a || a.kind === 'skip'
            ? '(skipped)'
            : a.kind === 'you_decide'
              ? '(author says: you decide)'
              : a.text;
        return `Q [${q.topic}]: ${q.question}\nA: ${answer}`;
      });
      return `## Round ${round.roundNo}\n${lines.join('\n\n')}`;
    })
    .join('\n\n');
}

const STAGE_INSTRUCTIONS = {
  ask: 'Ask the next round of 3-5 questions. Set kind to "questions" and bible to null.',
  draft:
    'The interview is over. Draft the complete story bible now. Set kind to "bible" and questions to [].',
  either:
    'If you have enough to draft a strong bible, draft it (kind "bible", questions []). Otherwise ask one more round of 3-5 questions (kind "questions", bible null).',
};

/** Runs one interview step: the next question round, or the draft bible. */
export async function runInterviewer(
  ctx: AgentContext,
  input: InterviewerInput,
): Promise<InterviewStepResult> {
  const stage = interviewStage(input.rounds.length);
  const nextRound = input.rounds.length + 1;
  const content = [
    `# Pitch\n${input.pitch}`,
    `# Interview so far\n${renderTranscript(input.rounds)}`,
    `# Your task\nThis is step ${nextRound} (at most ${MAX_INTERVIEW_ROUNDS} question rounds). ${STAGE_INSTRUCTIONS[stage]}`,
  ].join('\n\n');

  const out = await runStructuredAgent(ctx, {
    agent: 'interviewer',
    prompt: loadPrompt('interviewer'),
    tier: 'fast',
    messages: [{ role: 'user', content }],
    schema: interviewerOutputSchema,
    maxTokens: 32000,
    check: (out) => {
      const problems: string[] = [];
      if (stage === 'ask' && out.kind !== 'questions')
        problems.push('You must ask questions this round');
      if (stage === 'draft' && out.kind !== 'bible') problems.push('You must draft the bible now');
      if (out.kind === 'questions') {
        if (out.questions.length < 3 || out.questions.length > 5) {
          problems.push(`Ask 3-5 questions (asked ${out.questions.length})`);
        }
      } else if (!out.bible) {
        problems.push('kind is "bible" but bible is null');
      } else {
        problems.push(...validateSpine(out.bible.spine).map((p) => `spine: ${p}`));
      }
      return problems;
    },
  });
  return { ...out, questions: out.questions.map((q, i) => ({ id: `q${i + 1}`, ...q })) };
}

export interface ReviseSectionInput {
  pitch: string;
  bible: BibleContent;
  section: BibleSection;
  notes: string;
}

/** Regenerates one bible section from the author's notes, keeping the rest of the bible fixed. */
export async function reviseBibleSection<S extends BibleSection>(
  ctx: AgentContext,
  input: ReviseSectionInput & { section: S },
) {
  const content = [
    `# Pitch\n${input.pitch}`,
    `# Current bible\n${JSON.stringify(input.bible, null, 2)}`,
    `# Your task\nRewrite only the "${input.section}" section, following the author's notes below. Keep it consistent with the rest of the bible. Return just that section as a JSON object.`,
    `# Author's notes\n${input.notes || '(No notes: improve it as you see fit.)'}`,
  ].join('\n\n');

  // Indexing by a generic key loses the per-section type, so restore it here.
  const schema = bibleSectionSchemas[input.section] as unknown as z.ZodType<BibleContent[S]>;
  return runStructuredAgent(ctx, {
    agent: 'interviewer',
    prompt: loadPrompt('interviewer'),
    tier: 'fast',
    messages: [{ role: 'user', content }],
    schema,
    maxTokens: 32000,
    check: (value) =>
      input.section === 'spine' ? validateSpine(value as Spine).map((p) => `spine: ${p}`) : [],
  });
}
