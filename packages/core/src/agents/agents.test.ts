import { describe, expect, it } from 'vitest';
import { AgentOutputError, type LlmCallLog } from '../llm/runAgent.js';
import { buildDirectorContext } from '../context/buildContext.js';
import { beatStatus } from '../domain/beats.js';
import { FakeLlm } from '../testing/fakeLlm.js';
import {
  sampleBible,
  sampleInterviewBible,
  sampleInterviewRound,
  sampleNpcVoice,
  sampleOpening,
  sampleOutline,
  samplePitch,
} from '../testing/fixtures.js';
import { interviewStage, reviseBibleSection, runInterviewer } from './interviewer.js';
import { runOutliner } from './outliner.js';
import { runDirectorTurn, runNpcVoice } from './play.js';

function ctx(llm: FakeLlm) {
  const calls: LlmCallLog[] = [];
  return { calls, ctx: { llm, onCall: (log: LlmCallLog) => void calls.push(log) } };
}

/** Stored rounds carry the ids the server assigned. */
const storedQuestions = (round: number) =>
  sampleInterviewRound(round).questions.map((q, i) => ({ id: `q${i + 1}`, ...q }));

const answered = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    roundNo: i + 1,
    questions: storedQuestions(i + 1),
    answers: [{ questionId: 'q1', kind: 'answer' as const, text: 'Very dark' }],
  }));

describe('interviewStage', () => {
  it('asks for rounds 1-3, lets the model choose after 3, and drafts after 5', () => {
    expect(interviewStage(0)).toBe('ask');
    expect(interviewStage(2)).toBe('ask');
    expect(interviewStage(3)).toBe('either');
    expect(interviewStage(5)).toBe('draft');
  });
});

describe('runInterviewer', () => {
  it('returns the first round and logs the call with its prompt version', async () => {
    const { ctx: c, calls } = ctx(new FakeLlm([sampleInterviewRound(1)]));
    const out = await runInterviewer(c, { pitch: samplePitch, rounds: [] });
    expect(out.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
    expect(calls[0]).toMatchObject({
      agent: 'interviewer',
      promptVersion: 'interviewer@2+house-style@1',
    });
    expect(calls[0]!.costUsd).toBeGreaterThan(0);
  });

  it('shows the model the exact output schema', async () => {
    const llm = new FakeLlm([sampleInterviewRound(1)]);
    await runInterviewer(ctx(llm).ctx, { pitch: samplePitch, rounds: [] });
    const system = llm.requests[0]!.system;
    expect(system).toContain('## Output format');
    expect(system).toContain('"questions"');
    expect(system).toContain('"centralQuestion"');
  });

  it('renders skipped and "you decide" answers into the transcript', async () => {
    const llm = new FakeLlm([sampleInterviewRound(2)]);
    await runInterviewer(ctx(llm).ctx, {
      pitch: samplePitch,
      rounds: [
        {
          roundNo: 1,
          questions: storedQuestions(1),
          answers: [
            { questionId: 'q1', kind: 'skip', text: '' },
            { questionId: 'q2', kind: 'you_decide', text: '' },
            { questionId: 'q3', kind: 'answer', text: 'Novella' },
          ],
        },
      ],
    });
    const prompt = llm.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain('(skipped)');
    expect(prompt).toContain('(author says: you decide)');
    expect(prompt).toContain('A: Novella');
  });

  it('retries once when the model drafts too early, then accepts the correction', async () => {
    const llm = new FakeLlm([sampleInterviewBible, sampleInterviewRound(2)]);
    const { ctx: c, calls } = ctx(llm);
    const out = await runInterviewer(c, { pitch: samplePitch, rounds: answered(1) });
    expect(out.kind).toBe('questions');
    expect(calls).toHaveLength(2);
    const retry = llm.requests[1]!.messages.at(-1)!.content as string;
    expect(retry).toContain('You must ask questions this round');
  });

  it('requires the bible after five rounds', async () => {
    const { ctx: c } = ctx(new FakeLlm([sampleInterviewBible]));
    const out = await runInterviewer(c, { pitch: samplePitch, rounds: answered(5) });
    expect(out.bible?.title).toBe('The Tide Letters');
  });

  it('fails after a second invalid response', async () => {
    const { ctx: c } = ctx(new FakeLlm(['not json', '{"kind":"questions"}']));
    await expect(runInterviewer(c, { pitch: samplePitch, rounds: [] })).rejects.toBeInstanceOf(
      AgentOutputError,
    );
  });
});

describe('reviseBibleSection', () => {
  it('returns just the revised section', async () => {
    const revised = { ...sampleBible.styleGuide, tense: 'present' as const };
    const { ctx: c } = ctx(new FakeLlm([revised]));
    const out = await reviseBibleSection(c, {
      pitch: samplePitch,
      bible: sampleBible,
      section: 'styleGuide',
      notes: 'Present tense',
    });
    expect(out).toEqual(revised);
  });
});

describe('runOutliner', () => {
  it('uses the strong tier and returns a valid outline', async () => {
    const llm = new FakeLlm([sampleOutline]);
    const out = await runOutliner(ctx(llm).ctx, { bible: sampleBible });
    expect(out.chapters).toHaveLength(4);
    expect(llm.requests[0]!.tier).toBe('strong');
  });

  it('retries when an anchor is out of place', async () => {
    const moved = structuredClone(sampleOutline);
    moved.chapters[0]!.isAnchor = false;
    moved.chapters[0]!.anchorType = null;
    const llm = new FakeLlm([moved, sampleOutline]);
    await runOutliner(ctx(llm).ctx, { bible: sampleBible });
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain('The first bottle');
  });
});

describe('house style: dashes only for cut-off speech', () => {
  it('gives the director the house rules', async () => {
    const llm = new FakeLlm([sampleOpening]);
    const plan = sampleOutline.chapters[0]!;
    const context = buildDirectorContext(
      {
        bible: sampleBible,
        chapterNumber: 1,
        plan,
        beats: beatStatus(plan, [], []),
        characters: [],
        sceneCharacterIds: [],
        sceneLocationId: null,
        turns: [],
        lockedSummaries: [],
        facts: [],
        promises: [],
      },
      60_000,
    );
    const { ctx: c, calls } = ctx(llm);
    await runDirectorTurn(c, {
      context,
      input: null,
      onText: () => {},
      voiceCharacter: async () => '',
    });
    expect(llm.requests[0]!.system).toContain('only for speech that is cut off');
    expect(calls[0]!.promptVersion).toBe('director@1+house-style@1');
  });

  it('retries NPC dialogue that uses a dash outside cut-off speech', async () => {
    const dashed = { ...sampleNpcVoice, dialogue: 'The order is signed — I am sorry for it.' };
    const cutOff = { ...sampleNpcVoice, dialogue: 'The order is signed. I am—' };
    const llm = new FakeLlm([dashed, cutOff]);
    const out = await runNpcVoice(ctx(llm).ctx, 'You are Tomas Reyne');
    expect(out.dialogue).toBe(cutOff.dialogue);
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain('dash outside cut-off speech');
  });

  it('retries a draft bible whose style samples use dashes', async () => {
    const dashed = structuredClone(sampleInterviewBible);
    dashed.bible!.styleGuide.samples = ['The tide came in — without asking.'];
    const llm = new FakeLlm([dashed, sampleInterviewBible]);
    await runInterviewer(ctx(llm).ctx, { pitch: samplePitch, rounds: answered(5) });
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain('styleGuide.samples.0');
  });
});
