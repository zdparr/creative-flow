// Recorded agent outputs for tests: a small four-chapter novella. Every fixture must
// validate against its schema (see schemas.test.ts), so CI never calls the live API.
import type { BibleContent } from '../schemas/bible.js';
import type { CardContent } from '../schemas/character.js';
import type { InterviewerOutput } from '../schemas/interview.js';
import type { OutlinerOutput } from '../schemas/outline.js';
import type { ExtractorOutput, NpcVoiceOutput } from '../schemas/play.js';
import type { FakeStream } from './fakeLlm.js';

export const samplePitch =
  'A lighthouse keeper on a drowned coast finds letters in bottles addressed to her dead sister, written in the future.';

export const sampleBible: BibleContent = {
  title: 'The Tide Letters',
  spine: {
    centralQuestion:
      'Will Maren let her sister go, or drown trying to change what already happened?',
    theme: 'Grief that refuses the past becomes a second loss.',
    ending: {
      resolution: 'Maren sends the last letter unopened back to sea and relights the lamp.',
      cost: 'She gives up the only voice of Isla she will ever hear again.',
    },
    anchorBeats: [
      {
        type: 'inciting_incident',
        label: 'The first bottle',
        description: 'Maren finds a letter addressed to Isla dated next spring.',
        targetChapter: 1,
      },
      {
        type: 'midpoint_reversal',
        label: 'The letters are hers',
        description: 'Maren recognizes her own handwriting.',
        targetChapter: 2,
      },
      {
        type: 'dark_moment',
        label: 'The lamp goes dark',
        description: 'Chasing a bottle, Maren lets the lamp fail and a boat founders.',
        targetChapter: 3,
      },
      {
        type: 'climax',
        label: 'The last letter',
        description: 'Maren chooses not to read the final letter.',
        targetChapter: 4,
      },
    ],
    chapterCount: 4,
    targetWordCount: 20000,
  },
  world: {
    logline:
      'A grieving lighthouse keeper receives letters from the future and must choose between the dead and the living.',
    genre: 'Literary fantasy',
    tone: 'Melancholy, salt-bitten, quietly hopeful',
    setting: 'A half-drowned northern coast after the sea rose, 1970s technology.',
    locations: [
      { name: 'Skerry Light', description: 'A lighthouse on a tidal island, cut off twice a day.' },
      { name: 'Harrow', description: 'The village on the mainland, mostly abandoned.' },
    ],
    rules: ['Bottles only wash ashore at the new moon.', 'No one else can read the letters.'],
    cast: [
      {
        name: 'Maren Tull',
        role: 'protagonist',
        tier: 'major',
        summary: 'Keeper of Skerry Light, thirty-four, stubborn.',
        want: 'To speak to Isla once more.',
        flaw: 'Believes duty can hold back grief.',
        arcStart: 'Frozen in the night Isla drowned.',
        arcEnd: 'Keeps the light for the living.',
      },
      {
        name: 'Tomas Reyne',
        role: 'antagonist',
        tier: 'major',
        summary: 'The harbor authority inspector sent to decommission the light.',
        want: 'To close Skerry Light before winter.',
        flaw: 'Mistakes efficiency for kindness.',
        arcStart: 'Sees the lighthouse as a relic.',
        arcEnd: 'Signs the order to keep it lit.',
      },
    ],
  },
  styleGuide: {
    pov: 'third_limited',
    povCharacter: 'Maren Tull',
    tense: 'past',
    register: 'Spare, concrete, sea-weathered; sentences that break like waves.',
    bannedPhrases: ['a breath she did not know she was holding', 'suddenly'],
    samples: [
      'The tide came in the way it always had, without asking.',
      'She read the date twice, then a third time, as if the ink might change its mind.',
    ],
  },
};

export const sampleInterviewRound = (round: number): InterviewerOutput => ({
  kind: 'questions',
  questions: [
    { topic: 'tone', question: `Round ${round}: how dark should this get?` },
    { topic: 'ending', question: 'Does Maren keep the light?' },
    { topic: 'length', question: 'Novella or full novel?' },
  ],
  bible: null,
});

export const sampleInterviewBible: InterviewerOutput = {
  kind: 'bible',
  questions: [],
  bible: sampleBible,
};

export const sampleOutline: OutlinerOutput = {
  chapters: [
    {
      number: 1,
      title: 'New Moon',
      purpose: 'Establish Maren, the light, and the first impossible letter.',
      requiredBeats: [
        { id: 'c1-b1', description: 'Maren tends the lamp alone on the anniversary.' },
        { id: 'c1-b2', description: 'She finds the first bottle, addressed to Isla.' },
      ],
      arcsMoved: [{ character: 'Maren Tull', change: 'Hope cracks her routine.' }],
      isAnchor: true,
      anchorType: 'inciting_incident',
      promises: {
        planted: [
          { description: 'Who is writing the letters?', type: 'mystery', payoffChapter: 2 },
        ],
        paid: [],
      },
    },
    {
      number: 2,
      title: 'Her Own Hand',
      purpose: 'Tomas arrives; Maren learns the letters are in her handwriting.',
      requiredBeats: [
        { id: 'c2-b1', description: 'Tomas announces the decommissioning.' },
        { id: 'c2-b2', description: 'Maren matches the handwriting to her own.' },
      ],
      arcsMoved: [
        { character: 'Maren Tull', change: 'Obsession replaces duty.' },
        { character: 'Tomas Reyne', change: 'Sees her devotion and doubts his order.' },
      ],
      isAnchor: true,
      anchorType: 'midpoint_reversal',
      promises: {
        planted: [
          { description: 'The final letter is sealed.', type: 'planted_object', payoffChapter: 4 },
        ],
        paid: ['Who is writing the letters?'],
      },
    },
    {
      number: 3,
      title: 'Dark Water',
      purpose: 'Maren abandons the lamp to chase a bottle; a boat founders.',
      requiredBeats: [
        { id: 'c3-b1', description: 'Maren leaves the lamp unattended at night.' },
        { id: 'c3-b2', description: 'A fishing boat runs aground in the dark.' },
      ],
      arcsMoved: [{ character: 'Maren Tull', change: 'Sees what her grief has cost others.' }],
      isAnchor: true,
      anchorType: 'dark_moment',
      promises: { planted: [], paid: [] },
    },
    {
      number: 4,
      title: 'The Last Letter',
      purpose: 'Maren sends the last letter back and relights the lamp.',
      requiredBeats: [
        { id: 'c4-b1', description: 'Maren holds the sealed letter at the tideline.' },
        { id: 'c4-b2', description: 'She relights the lamp; Tomas signs to keep it.' },
      ],
      arcsMoved: [
        { character: 'Maren Tull', change: 'Keeps the light for the living.' },
        { character: 'Tomas Reyne', change: 'Signs the order to keep the light.' },
      ],
      isAnchor: true,
      anchorType: 'climax',
      promises: { planted: [], paid: ['The final letter is sealed.'] },
    },
  ],
};

// ---------- play (chapter 1 of the sample outline) ----------

export const sampleOpening: FakeStream = {
  stream: [
    'The lamp turned its slow white eye across the water. ',
    'Maren climbed the last of the hundred and twelve stairs, as she had every night since Isla.',
  ],
};

export const sampleOpeningExtraction: ExtractorOutput = {
  summary: 'Maren tends the lamp alone on the anniversary of Isla drowning.',
  characters: ['Maren Tull'],
  location: 'Skerry Light',
  beatsHit: ['c1-b1'],
  newCharacters: [],
  facts: [
    {
      kind: 'timeline',
      statement: 'The chapter opens on the anniversary of Isla drowning.',
      entities: ['Maren Tull'],
    },
  ],
  promises: [],
  drift: [],
};

export const sampleTurnNarration: FakeStream = {
  stream: [
    'At the tideline a green bottle rolled against her boot. ',
    'Inside, a letter: "Isla," it began, and it was dated next spring.',
  ],
};

export const sampleTurnExtraction: ExtractorOutput = {
  summary: 'Maren finds a bottle holding a letter to Isla dated next spring.',
  characters: ['Maren Tull'],
  location: 'Skerry Light',
  beatsHit: ['c1-b2'],
  newCharacters: [
    { name: 'Old Hendry', proposedTier: 'walk_on', role: 'ferryman', trait: 'never speaks first' },
  ],
  facts: [
    {
      kind: 'object',
      statement: 'Maren has the first bottle and its letter.',
      entities: ['Maren Tull'],
    },
  ],
  promises: [
    {
      type: 'mystery',
      description: 'Who wrote the letter from the future?',
      entities: ['Maren Tull'],
    },
  ],
  drift: [],
};

export const sampleNpcVoice: NpcVoiceOutput = {
  action: 'Tomas sets his clipboard on the wet rail.',
  dialogue: 'The order is signed, Miss Tull. I am sorry for it.',
};

// ---------- characters (Phase 4) ----------

/** A turn in which a minor character is newly named. */
export const sampleMinorCharacterExtraction: ExtractorOutput = {
  summary:
    'Ada Fenn, the harbor clerk, rows out with the post and warns Maren about the inspector.',
  characters: ['Maren Tull', 'Ada Fenn'],
  location: 'Skerry Light',
  beatsHit: ['c1-b2'],
  newCharacters: [
    { name: 'Ada Fenn', proposedTier: 'minor', role: 'harbor clerk', trait: 'gossips to be kind' },
  ],
  facts: [],
  promises: [],
  drift: [],
};

/** The card drafter's output for Ada Fenn at the minor tier. */
export const sampleAdaCard = {
  role: 'harbor clerk',
  location: 'Harrow harbor office',
  trait: 'gossips to be kind',
  firstAppearance: 1,
  storyRole: 'Brings Maren news from the mainland and the first warning about Tomas.',
  want: 'To keep Harrow from emptying out entirely.',
  relationshipToProtagonist: "Isla's old school friend; treats Maren like a sister she must mind.",
  voiceNote: 'Quick, warm, always halfway into the next story.',
};

/** A complete major card, for tests that need one. */
export const sampleMajorCard: CardContent = {
  ...sampleAdaCard,
  principles: ['Never lies to Maren', 'Never leaves Harrow'],
  goal: 'Keep the village alive.',
  fearOrFlaw: 'Afraid of being the last one left.',
  secret: 'She sent the letter that brought the inspector.',
  arcStart: 'Holds the village together by talking.',
  arcEnd: 'Lets people leave with her blessing.',
  checkpoints: [{ chapter: 3, description: 'Admits she called the inspector.', met: false }],
  keyRelationships: [{ name: 'Maren Tull', relationship: 'protective friend' }],
  voiceSamples: ['You look like the tide dragged you here.', 'I only tell the true ones.'],
};
