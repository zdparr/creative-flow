import { describe, expect, it } from 'vitest';
import { AgentOutputError, type LlmCallLog } from '../llm/runAgent.js';
import { FakeLlm } from '../testing/fakeLlm.js';
import { sampleBible, sampleOutline } from '../testing/fixtures.js';
import { type DeepenerInput, applyDeepening, runDeepener } from './deepener.js';

const paragraphs = [
  'The bell rang twice across the yard, and Maren set down the bucket she had been carrying.',
  'Tomas stood at the gate with the order in his gloved hand, waiting for her to come to him.',
  'She took the paper from him and read it slowly, once and then again, while the gulls wheeled overhead.',
  'The light would close at the end of the month. There was no appeal written anywhere on it.',
  'She folded the order in half and put it into her coat, beside the letter she had told no one about.',
  'That night she climbed the tower and lit the lamp anyway, as she had every night for nine years.',
];
const prose = [...paragraphs.slice(0, 3), '#', ...paragraphs.slice(3)].join('\n\n');

const plan = {
  ...sampleOutline.chapters[1]!,
  requiredBeats: [
    { id: 'c2-b1', description: 'Tomas delivers the order.', pivotal: true },
    { id: 'c2-b2', description: 'Maren lights the lamp.' },
  ],
};

const input: DeepenerInput = {
  bible: sampleBible,
  chapterNumber: 2,
  plan,
  events: [
    {
      summary: 'Tomas delivers the order to close the light.',
      characters: ['Maren Tull', 'Tomas Reyne'],
      location: 'Skerry Light',
      interiorityNote: null,
      authorNote: null,
      dialogue: [],
      pivotal: true,
    },
  ],
  cards: [],
  commitments: [
    {
      kind: 'secret',
      from: 'Isla Tull',
      to: ['Maren Tull'],
      content: 'Maren keeps the letters to herself.',
      scope: 'no one at all',
      words: 'Tell no one about these.',
      chapter: 1,
      tested: [],
      entities: ['maren'],
    },
  ],
  threads: ['Who is writing the letters?'],
  prose,
};

function ctx(llm: FakeLlm) {
  const calls: LlmCallLog[] = [];
  return { calls, ctx: { llm, onCall: (log: LlmCallLog) => void calls.push(log) } };
}

const valid = {
  pivotalMoments: [{ paragraph: 3, moment: 'reading the order' }],
  edits: [
    {
      paragraph: 3,
      text: `${paragraphs[2]} *Not yet,* she thought. *Not the light.*`,
    },
  ],
  inserts: [{ after: 6, text: 'Below her, the dark water took the beam and gave nothing back.' }],
};

describe('applyDeepening', () => {
  it('places edits and inserts by paragraph number and keeps scene breaks', () => {
    const out = applyDeepening(prose, {
      edits: [{ paragraph: 4, text: 'Edited four.\n\nSplit four.' }],
      inserts: [
        { after: 0, text: 'Opening.' },
        { after: 3, text: 'After three, a.\n\nAfter three, b.' },
      ],
    });
    expect(out.split('\n\n')).toEqual([
      'Opening.',
      paragraphs[0],
      paragraphs[1],
      paragraphs[2],
      'After three, a.',
      'After three, b.',
      '#',
      'Edited four.',
      'Split four.',
      paragraphs[4],
      paragraphs[5],
    ]);
  });
});

describe('runDeepener', () => {
  it('applies an additive pass and gives the model the plan, commitments, threads, and breaks', async () => {
    const llm = new FakeLlm([valid]);
    const { ctx: agent, calls } = ctx(llm);
    const result = await runDeepener(agent, input);

    expect(result.prose).toContain('*Not yet,* she thought.');
    expect(result.prose.split('\n\n').at(-1)).toBe(valid.inserts[0]!.text);
    expect(result.retention.retained).toBe(1);
    expect(result.retention.growth).toBeGreaterThan(0.1);
    expect(result.pivotalMoments).toEqual(valid.pivotalMoments);
    expect(calls).toMatchObject([
      { agent: 'deepener', promptVersion: 'deepener@1+house-style@1+prose-mechanics@1' },
    ]);

    const prompt = llm.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain('- (PIVOTAL) Tomas delivers the order.');
    expect(prompt).toContain('1. (PIVOTAL) Tomas delivers the order to close the light.');
    expect(prompt).toContain('Maren keeps the letters to herself. Scope: no one at all.');
    expect(prompt).toContain('- Who is writing the letters?');
    expect(prompt).toContain('[3] She took the paper');
    expect(prompt).toContain('# (scene break)\n\n[4]');
    expect(llm.requests[0]!.system).toContain('Slow down the pivotal moments');
    expect(llm.requests[0]!.system).toContain('Prose mechanics');
  });

  it('retries a pass that rewrites a paragraph instead of adding to it', async () => {
    const rewrite = {
      ...valid,
      edits: [{ paragraph: 2, text: 'Tomas waited by the gate, holding out a letter for her.' }],
    };
    const llm = new FakeLlm([rewrite, valid]);
    const result = await runDeepener(ctx(llm).ctx, input);
    expect(result.prose).toContain('*Not yet,*');
    const retry = llm.requests[1]!.messages.at(-1)!.content as string;
    expect(retry).toContain('paragraph 2 rewrites the draft');
  });

  it('rejects a pass that runs past the length cap or breaks the house style', async () => {
    const long = {
      ...valid,
      inserts: [{ after: 6, text: 'The sea went on and on. '.repeat(10).trim() }],
    };
    const dashed = {
      ...valid,
      inserts: [{ after: 6, text: 'The beam swept out — and came back empty.' }],
    };
    const llm = new FakeLlm([long, dashed]);
    await expect(runDeepener(ctx(llm).ctx, input)).rejects.toBeInstanceOf(AgentOutputError);
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain('cut additions to stay under 18%');
  });

  it('rejects new scene breaks and out-of-range paragraphs', async () => {
    const bad = {
      pivotalMoments: [],
      edits: [{ paragraph: 9, text: 'Nine.' }],
      inserts: [{ after: 2, text: 'A line.\n\n#\n\nAnother.' }],
    };
    const llm = new FakeLlm([bad, bad]);
    const err = await runDeepener(ctx(llm).ctx, input).catch((e: AgentOutputError) => e);
    expect(err).toBeInstanceOf(AgentOutputError);
    expect((err as AgentOutputError).problems).toEqual([
      'edits: paragraph 9 does not exist (1-6)',
      'Do not add or remove scene breaks',
    ]);
  });
});
