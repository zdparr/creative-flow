// The seeded test book (Phases 5-7): three short chapters with three planted violations for
// the cohesion critic to catch:
// 1. a promise planted in chapter 1 and left unpaid past its window (chapter 2);
// 2. a knowledge violation (chapter 2: Tomas mentions letters he cannot know about);
// 3. a principle violation (chapter 3: Tomas falsifies his report).
import type { BibleContent } from '../schemas/bible.js';
import type { CardContent } from '../schemas/character.js';
import type { CriticOutput } from '../schemas/cohesion.js';
import type { OutlinerOutput } from '../schemas/outline.js';
import type { ExtractorOutput } from '../schemas/play.js';
import type { BookReviewOutput, ReplanOutput } from '../schemas/replan.js';
import type { FakeStream } from './fakeLlm.js';
import { sampleBible } from './fixtures.js';

export const seedBible: BibleContent = {
  ...sampleBible,
  spine: {
    ...sampleBible.spine,
    chapterCount: 3,
    targetWordCount: 3000,
    anchorBeats: [
      {
        type: 'inciting_incident',
        label: 'The first bottle',
        description: 'Maren finds a letter addressed to Isla dated next spring.',
        targetChapter: 1,
      },
      {
        type: 'midpoint_reversal',
        label: 'The inspector',
        description: 'Tomas arrives with the order to close the light.',
        targetChapter: 2,
      },
      {
        type: 'climax',
        label: 'Keep the light',
        description: 'Maren relights the lamp and Tomas must decide what to report.',
        targetChapter: 3,
      },
    ],
  },
};

export const seedOutline: OutlinerOutput = {
  chapters: [
    {
      number: 1,
      title: 'New Moon',
      purpose: 'Maren finds the first letter.',
      requiredBeats: [
        { id: 's1-b1', description: 'Maren finds a bottle holding a letter to Isla.' },
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
      title: 'The Inspector',
      purpose: 'Tomas arrives to close the light.',
      requiredBeats: [{ id: 's2-b1', description: 'Tomas delivers the decommission order.' }],
      arcsMoved: [{ character: 'Tomas Reyne', change: 'Sees her devotion and doubts his order.' }],
      isAnchor: true,
      anchorType: 'midpoint_reversal',
      promises: { planted: [], paid: ['Who is writing the letters?'] },
    },
    {
      number: 3,
      title: 'Keep the Light',
      purpose: 'Maren relights the lamp; Tomas files his report.',
      requiredBeats: [{ id: 's3-b1', description: 'Tomas files his inspection report.' }],
      arcsMoved: [{ character: 'Tomas Reyne', change: 'Signs to keep the light.' }],
      isAnchor: true,
      anchorType: 'climax',
      promises: { planted: [], paid: [] },
    },
  ],
};

/** Tomas as a complete major card; his principle is what chapter 3 violates. */
export const seedTomasCard: CardContent = {
  role: 'harbor authority inspector',
  location: 'Harrow',
  trait: 'precise to a fault',
  firstAppearance: 1,
  storyRole: 'Sent to close Skerry Light before winter.',
  want: 'To close the light before winter.',
  relationshipToProtagonist: 'An adversary who comes to respect her.',
  voiceNote: 'Formal, clipped, and apologetic.',
  principles: ['Never falsifies an inspection report.'],
  goal: 'Close Skerry Light.',
  fearOrFlaw: 'Mistakes efficiency for kindness.',
  secret: 'His brother drowned off an unlit coast.',
  arcStart: 'Sees the lighthouse as a relic.',
  arcEnd: 'Signs the order to keep it lit.',
  checkpoints: [{ chapter: 2, description: 'Doubts his order.', met: false }],
  keyRelationships: [{ name: 'Maren Tull', relationship: 'adversary' }],
  voiceSamples: ['The order is signed, Miss Tull.', 'I report what I find.'],
};

export interface SeedChapter {
  opening: FakeStream;
  extraction: ExtractorOutput;
  prose: string;
  critic: CriticOutput;
}

const summary = (s: string) => `${s} ${'The tide turned and the light held. '.repeat(20)}`.trim();

export const seedChapters: Record<1 | 2 | 3, SeedChapter> = {
  1: {
    opening: {
      stream: [
        'At the tideline a green bottle rolled against her boot. Inside was a letter to Isla.',
      ],
    },
    extraction: {
      summary: 'Maren finds a bottle holding a letter to Isla, dated next spring.',
      characters: ['Maren Tull'],
      location: 'Skerry Light',
      beatsHit: ['s1-b1'],
      newCharacters: [],
      facts: [
        {
          kind: 'object',
          statement: 'Maren has a letter addressed to Isla, dated next spring.',
          entities: ['Maren Tull'],
        },
      ],
      promises: [
        { type: 'mystery', description: 'Who is writing the letters?', entities: ['Maren Tull'] },
      ],
      drift: [],
    },
    prose: [
      'The lamp turned its slow white eye across the water, and Maren climbed to meet it.',
      'At the tideline a green bottle rolled against her boot. Inside was a letter to Isla, dated next spring.',
    ].join('\n\n'),
    critic: {
      issues: [],
      paidPromiseIds: [],
      promisesPlanted: [
        { description: 'Who is writing the letters?', type: 'mystery', payoffChapter: 2 },
      ],
      checkpointsMet: [],
      factCorrections: [],
      summary: summary('Maren finds a letter to her dead sister, dated next spring.'),
    },
  },
  2: {
    opening: {
      stream: ['Tomas Reyne came across the causeway at low tide with the order in his case.'],
    },
    extraction: {
      summary: 'Tomas Reyne delivers the order to decommission Skerry Light.',
      characters: ['Maren Tull', 'Tomas Reyne'],
      location: 'Skerry Light',
      beatsHit: ['s2-b1'],
      newCharacters: [],
      facts: [
        {
          kind: 'event',
          statement: 'Tomas has delivered the order to close Skerry Light.',
          entities: ['Tomas Reyne', 'Maren Tull'],
        },
      ],
      promises: [],
      drift: [],
    },
    prose: [
      'Tomas Reyne came across the causeway at low tide with the order in his case.',
      '"The light closes at the end of the month," he said. "And the letters to your sister, Miss Tull. You should stop answering them."',
    ].join('\n\n'),
    critic: {
      issues: [
        {
          severity: 'blocker',
          category: 'knowledge',
          paragraph: 2,
          description:
            'Tomas mentions the letters to Isla, which he has never seen or been told about.',
          evidence:
            'Knowledge map: only Maren knows "Maren has a letter addressed to Isla, dated next spring." World rule: no one else can read the letters.',
          suggestedFix: 'Cut the line about the letters, or have Tomas see Maren with one first.',
        },
      ],
      paidPromiseIds: [],
      promisesPlanted: [],
      checkpointsMet: [{ character: 'Tomas Reyne', chapter: 2 }],
      factCorrections: [],
      summary: summary('Tomas delivers the order to close the light.'),
    },
  },
  3: {
    opening: {
      stream: ['The lamp burned through the night, and in the morning Tomas sat down to write.'],
    },
    extraction: {
      summary: 'Tomas files his inspection report on Skerry Light.',
      characters: ['Maren Tull', 'Tomas Reyne'],
      location: 'Skerry Light',
      beatsHit: ['s3-b1'],
      newCharacters: [],
      facts: [],
      promises: [],
      drift: [],
    },
    prose: [
      'The lamp burned through the night, and in the morning Tomas sat down to write.',
      'He wrote that the lamp had never once failed, though he had watched it go dark himself, and signed his name beneath the lie.',
    ].join('\n\n'),
    critic: {
      issues: [
        {
          severity: 'blocker',
          category: 'principle',
          paragraph: 2,
          description:
            'Tomas knowingly writes a false report without the story treating it as a turning point.',
          evidence: 'Tomas Reyne card, principles: "Never falsifies an inspection report."',
          suggestedFix:
            'Have Tomas report the failure truthfully and argue to keep the light anyway.',
        },
      ],
      paidPromiseIds: [],
      promisesPlanted: [],
      checkpointsMet: [],
      factCorrections: [],
      summary: summary('Tomas files his report and the light is kept.'),
    },
  },
};

export const sampleReplan: ReplanOutput = { changes: [] };

export const sampleBookReview: BookReviewOutput = {
  summary: 'A compact novella whose three chapters build cleanly toward the lamp relit.',
  issues: [
    {
      chapter: 2,
      category: 'pacing',
      severity: 'note',
      description: 'Chapter 2 moves quickly past Tomas arriving.',
      suggestion: 'Give his crossing a paragraph more.',
    },
  ],
};
