// Recorded agent outputs for tests: a small four-chapter novella. Every fixture must
// validate against its schema (see schemas.test.ts), so CI never calls the live API.
import type { BibleContent } from '../schemas/bible.js';
import type { InterviewerOutput } from '../schemas/interview.js';
import type { OutlinerOutput } from '../schemas/outline.js';

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
    { id: 'q1', topic: 'tone', question: `Round ${round}: how dark should this get?` },
    { id: 'q2', topic: 'ending', question: 'Does Maren keep the light?' },
    { id: 'q3', topic: 'length', question: 'Novella or full novel?' },
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
