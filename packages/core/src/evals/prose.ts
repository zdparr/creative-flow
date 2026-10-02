// Live evaluation of the deepening pass on the test chapter ("The Weakest Light"). It runs the
// pass on the engine's original draft, checks it against the additive guard, and has a judge
// score both the engine's pass and the human editor's revision of the same draft on the eight
// craft layers and the qualities to protect. The editor's revision is a yardstick only; it is
// never shown to the deepener.
//
//   ANTHROPIC_API_KEY=... pnpm eval:prose
//
// It costs three strong-tier calls.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DEEPEN_MAX_GROWTH,
  DEEPEN_MIN_RETAINED,
  DEEPEN_TARGET_GROWTH,
  type DeepenerInput,
  runDeepener,
} from '../agents/deepener.js';
import { loadWorkerEnv } from '../config.js';
import { AnthropicLlmClient } from '../llm/client.js';
import { runStructuredAgent } from '../llm/runAgent.js';
import { retention } from '../prose/retention.js';
import { sampleBible } from '../testing/fixtures.js';

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../fixtures/weakest-light/${name}.txt`, import.meta.url)),
    'utf8',
  );
const original = fixture('original');
const edited = fixture('revised');

const env = loadWorkerEnv({ DATABASE_URL: 'unused', REDIS_URL: 'unused', ...process.env });
const llm = new AnthropicLlmClient({
  apiKey: env.ANTHROPIC_API_KEY,
  models: { fast: env.MODEL_FAST, strong: env.MODEL_STRONG },
  structuredOutputs: env.STRUCTURED_OUTPUTS,
});
let cost = 0;
const ctx = { llm, onCall: (log: { costUsd: number }) => void (cost += log.costUsd) };

const event = (summary: string, pivotal = false) => ({
  summary,
  characters: [],
  location: null,
  interiorityNote: null,
  authorNote: null,
  dialogue: [],
  pivotal,
});

// What play would have recorded for this chapter. Hollin's order is in the chronicle and the
// commitments, as it would be had it been spoken in play, so layers 3 and 4 can be tested.
const input: DeepenerInput = {
  bible: {
    ...sampleBible,
    title: 'The Weakest Light',
    styleGuide: {
      pov: 'third_limited',
      povCharacter: 'Bran Greyholdt',
      tense: 'past',
      register: 'restrained, concrete, quietly ominous; understatement over explanation',
      bannedPhrases: [],
      samples: [
        'It was also meant to cost something. Every light did. A ward-light was not a large working, but it drew on the one who made it the way every working did: a little breath, a little warmth, a little of whatever it was that kept a person alive.',
      ],
    },
  },
  chapterNumber: 1,
  plan: {
    number: 1,
    title: 'The Weakest Light',
    purpose:
      'Establish Bran as the Order apprentice whose magic will not answer, plant the wardstone and Vane, and send Bran toward Mount Threshold.',
    requiredBeats: [
      {
        id: 'c1-b1',
        description: "Bran's ward-light fails at the king's mourning rite; Hollin covers for him.",
        pivotal: true,
      },
      {
        id: 'c1-b2',
        description: 'Bran finds a warm, humming wardstone from Mount Threshold and logs it inert.',
        pivotal: true,
      },
      { id: 'c1-b3', description: 'Lord Chancellor Vane questions Bran in the courtyard.' },
      { id: 'c1-b4', description: 'Hollin tells Bran he is coming to Mount Threshold.' },
    ],
    arcsMoved: [{ character: 'Bran Greyholdt', change: 'Shame turns into a secret of his own.' }],
    isAnchor: true,
    anchorType: 'inciting_incident',
    promises: { planted: [], paid: [] },
  },
  events: [
    event(
      "Bran's ward-light fails during the mourning rite; Hollin raises a light in its place.",
      true,
    ),
    event("Vane, across the hall, meets Bran's eyes and nods."),
    event(
      'In the corridor Hollin asks who saw the light fail, then orders Bran to tell no one, apprentice or mage, about the failures, and sends him to catalogue the vault.',
    ),
    event(
      'In the vault Bran finds a warm wardstone from Mount Threshold that hums in him; he logs it inert.',
      true,
    ),
    event('Bran dreams of shelves and the mourning hall.'),
    event(
      'Vane approaches Bran in the courtyard, knows his Order records, says he saw the light fail, and asks what failing feels like; his palms are bandaged and bleeding.',
    ),
    event(
      'The assembly bell rings: the delegation will go to Mount Threshold; Hollin will lead it.',
    ),
    event('Hollin tells Bran he is coming, because it is not safe to leave him behind.'),
    event(
      'Bran sees Hollin conferring in secret over a folded letter; on the fifth morning they leave.',
    ),
  ],
  cards: [
    {
      id: 'bran',
      name: 'Bran Greyholdt',
      tier: 'major',
      card: {
        role: "apprentice to the King's mage",
        principles: ['Never lets another pay for his failures if he can help it.'],
        fearOrFlaw: 'Believes he is the weakest mage the Order has trained.',
      },
    },
    {
      id: 'hollin',
      name: 'Master Hollin',
      tier: 'major',
      card: { role: "the King's mage", voiceNote: 'Curt, low, protective under the edge.' },
    },
    {
      id: 'vane',
      name: 'Aldric Vane',
      tier: 'major',
      card: { role: 'Lord Chancellor', voiceNote: 'Quiet, warm, always a little too interested.' },
    },
  ],
  commitments: [
    {
      kind: 'instruction',
      from: 'Master Hollin',
      to: ['Bran Greyholdt'],
      content: 'Bran tells no one about his light failing, at the rite or before.',
      scope: 'no one: not another apprentice, not another mage',
      words: '',
      chapter: 1,
      tested: [],
      entities: ['hollin', 'bran'],
    },
  ],
  threads: [
    'What is the wardstone, and why does it answer Bran?',
    "Why are Vane's palms bandaged and bleeding?",
    'What letter are Hollin and the senior mages hiding?',
  ],
  prose: original,
};

const LAYERS = [
  'Pivotal moments slowed into a lived beat sequence (anticipation, false hope, felt slip, response, failure, aftershock)',
  'Emotional consequence and dilemma after a cost falls on someone else (what hurts, options, choice)',
  'A secret or instruction stated plainly, with a scope',
  'That instruction recalled under pressure, a visible judgment about disclosure, and noticing an overstep',
  'The protagonist registering that someone knows too much (one sentence, no conclusion)',
  "One glimpse of a different emotion beneath an authority figure's harshness (hinted, not explained)",
  'Scenes and the chapter buttoned with a resonant closing line; chapter ends on its motif or mystery',
  'Mechanics: direct thought in italics; self-questions end with question marks',
];
const PROTECT = [
  'concrete sensory description',
  'restrained understatement',
  'magic that has a cost',
  'mysteries planted without explanation',
  'dreams that echo earlier scenes',
  'dialogue that sounds like people',
];

const judgeSchema = z.object({
  layers: z
    .array(
      z.object({
        layer: z.number().int().describe('1-8, in the order given'),
        present: z.boolean(),
        quality: z.number().int().describe('1 (weak) to 5 (as good as a skilled editor)'),
        evidence: z.string().describe('A short quote from the revision, or why it is missing'),
      }),
    )
    .describe('One entry per craft layer'),
  protected: z
    .array(
      z.object({
        quality: z.string(),
        regressed: z.boolean().describe('True if the revision weakened this'),
        note: z.string(),
      }),
    )
    .describe('One entry per quality to protect'),
  melodrama: z.boolean().describe('True if any addition is overwrought or explains a subtext hint'),
  inventedPlot: z
    .array(z.string())
    .describe(
      'Events in the revision that are in neither the draft nor the chronicle; usually empty',
    ),
  verdict: z.string().describe('Two sentences on the revision overall'),
});
type Judgement = z.infer<typeof judgeSchema>;

async function judge(revision: string): Promise<Judgement> {
  return runStructuredAgent(ctx, {
    agent: 'prose_judge',
    prompt: {
      version: 'prose-judge@eval',
      system:
        'You are a senior fiction editor judging a revision of a chapter draft. The revision should add craft layers without changing the voice or the plot. Be strict and specific; a layer is present only if the revision clearly does it. Respond with JSON only, matching the requested schema.',
    },
    tier: 'strong',
    messages: [
      {
        role: 'user',
        content: [
          `# Craft layers\n${LAYERS.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
          `# Qualities to protect\n${PROTECT.map((p) => `- ${p}`).join('\n')}`,
          `# Chronicle (what happened)\n${input.events.map((e, i) => `${i + 1}. ${e.summary}`).join('\n')}`,
          `# The draft\n${original}`,
          `# The revision\n${revision}`,
        ].join('\n\n'),
      },
    ],
    schema: judgeSchema,
    maxTokens: 8000,
  });
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const report = (label: string, j: Judgement) => {
  console.log(`\n${label}`);
  for (const l of j.layers) {
    console.log(
      `  ${l.present ? 'yes' : ' no'} q${l.quality}  ${l.layer}. ${LAYERS[l.layer - 1]?.split(' (')[0]}`,
    );
    console.log(`           ${l.evidence.slice(0, 140)}`);
  }
  const regressed = j.protected.filter((p) => p.regressed);
  console.log(
    `  protected: ${regressed.length ? regressed.map((p) => `${p.quality} (${p.note})`).join('; ') : 'no regressions'}`,
  );
  console.log(
    `  melodrama: ${j.melodrama ? 'yes' : 'no'}; invented plot: ${j.inventedPlot.join('; ') || 'none'}`,
  );
  console.log(`  ${j.verdict}`);
};

const human = retention(original, edited);
console.log(
  `Editor's revision: kept ${pct(human.retained)} of the draft, grew ${pct(human.growth)}`,
);

const deep = await runDeepener(ctx, input);
const r = deep.retention;
console.log(`Deepening pass:    kept ${pct(r.retained)} of the draft, grew ${pct(r.growth)}`);
console.log(
  `  ${deep.edited} paragraphs added to, ${deep.inserted} inserts; pivotal: ${deep.pivotalMoments.map((m) => `¶${m.paragraph} ${m.moment}`).join(', ')}`,
);

const [engine, editor] = await Promise.all([judge(deep.prose), judge(edited)]);
report('Judge: deepening pass', engine);
report("Judge: editor's revision (yardstick)", editor);

const checks: [string, boolean][] = [
  [`keeps at least ${pct(DEEPEN_MIN_RETAINED)}`, r.retained >= DEEPEN_MIN_RETAINED],
  [
    `grows ${pct(DEEPEN_TARGET_GROWTH.min - 0.02)}-${pct(DEEPEN_MAX_GROWTH)}`,
    r.growth >= DEEPEN_TARGET_GROWTH.min - 0.02 && r.growth <= DEEPEN_MAX_GROWTH,
  ],
  ['at least 6 of 8 layers present', engine.layers.filter((l) => l.present).length >= 6],
  ['no protected quality regressed', engine.protected.every((p) => !p.regressed)],
  ['no melodrama', !engine.melodrama],
  ['no invented plot', engine.inventedPlot.length === 0],
];
console.log('');
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}`);
console.log(`\n(cost $${cost.toFixed(4)})`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
