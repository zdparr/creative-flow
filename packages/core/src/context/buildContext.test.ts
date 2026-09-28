import { describe, expect, it } from 'vitest';
import { beatStatus } from '../domain/beats.js';
import { cardFromCast } from '../schemas/character.js';
import { sampleBible, sampleOutline } from '../testing/fixtures.js';
import {
  type CharacterCard,
  type ContextFact,
  type DirectorContextInput,
  buildDirectorContext,
  buildNpcContext,
} from './buildContext.js';

const maren: CharacterCard = {
  id: 'maren',
  name: 'Maren Tull',
  tier: 'major',
  card: cardFromCast(sampleBible.world.cast[0]!),
};
const tomas: CharacterCard = {
  id: 'tomas',
  name: 'Tomas Reyne',
  tier: 'major',
  card: cardFromCast(sampleBible.world.cast[1]!),
};
const clerk: CharacterCard = {
  id: 'clerk',
  name: 'Ada Fenn',
  tier: 'walk_on',
  card: { trait: 'Harbor clerk' },
};
const plan = sampleOutline.chapters[1]!;

function input(overrides: Partial<DirectorContextInput> = {}): DirectorContextInput {
  return {
    bible: sampleBible,
    chapterNumber: 2,
    plan,
    beats: beatStatus(plan, [], []),
    characters: [maren, tomas, clerk],
    sceneCharacterIds: ['maren', 'tomas'],
    sceneLocationId: 'skerry',
    turns: Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? ('director' as const) : ('author' as const),
      inputKind: i % 2 ? null : ('in_character' as const),
      content: `turn-${i} ${'x'.repeat(200)}`,
    })),
    lockedSummaries: [
      { number: 0, summary: 'summary-zero' },
      { number: 1, summary: `summary-one ${'y'.repeat(400)}` },
    ],
    facts: [],
    promises: [],
    ...overrides,
  };
}

describe('buildDirectorContext', () => {
  it('includes spine, plan, beats, and in-scene cards; excludes walk-ons out of scene', () => {
    const ctx = buildDirectorContext(input(), 100_000);
    expect(ctx.stable).toContain(sampleBible.spine.centralQuestion);
    expect(ctx.volatile).toContain(plan.purpose);
    expect(ctx.volatile).toContain('[ ] c2-b1');
    expect(ctx.volatile).toContain('Tomas Reyne (major)');
    expect(ctx.volatile).not.toContain('Ada Fenn');
  });

  it('keeps only the last 20 turns', () => {
    const ctx = buildDirectorContext(input(), 100_000);
    expect(ctx.volatile).not.toContain('turn-9 ');
    expect(ctx.volatile).toContain('turn-10 ');
    expect(ctx.volatile).toContain('turn-29 ');
  });

  it('trims oldest turns first, then oldest summaries, then low-severity facts', () => {
    const facts: ContextFact[] = [
      { kind: 'timeline', statement: 'fact-low', entities: ['maren'], chapter: 1 },
      { kind: 'injury', statement: 'fact-high', entities: ['maren'], chapter: 1 },
    ];
    const roomy = buildDirectorContext(input({ facts }), 100_000);
    expect(roomy.dropped).toEqual({ turns: 0, summaries: 0, facts: 0 });

    // Tight enough to force every stage of trimming.
    const tight = buildDirectorContext(input({ facts }), estimateBase() + 20);
    expect(tight.dropped.turns).toBe(16); // down to the 4-turn floor
    expect(tight.dropped.summaries).toBe(2);
    expect(tight.dropped.facts).toBe(2);
    expect(tight.volatile).toContain(plan.purpose);
    expect(tight.volatile).toContain('Tomas Reyne (major)');
    expect(tight.overBudget).toBe(true);

    // Just enough room for one fact: the high-severity one survives.
    const partial = buildDirectorContext(
      input({ facts, turns: [], lockedSummaries: [] }),
      sizeWith('fact-high'),
    );
    expect(partial.volatile).toContain('fact-high');
    expect(partial.volatile).not.toContain('fact-low');
  });

  it('only includes facts tied to entities in the scene', () => {
    const ctx = buildDirectorContext(
      input({
        facts: [
          { kind: 'event', statement: 'about-maren', entities: ['maren'], chapter: 1 },
          { kind: 'event', statement: 'about-the-clerk', entities: ['clerk'], chapter: 1 },
          { kind: 'location', statement: 'about-skerry', entities: ['skerry'], chapter: 1 },
        ],
      }),
      100_000,
    );
    expect(ctx.volatile).toContain('about-maren');
    expect(ctx.volatile).toContain('about-skerry');
    expect(ctx.volatile).not.toContain('about-the-clerk');
  });

  it('includes only promises open in this chapter', () => {
    const ctx = buildDirectorContext(
      input({
        promises: [
          { description: 'open-now', plantedChapter: 1, payoffChapter: 3, entities: [] },
          { description: 'already-due', plantedChapter: 1, payoffChapter: 1, entities: [] },
          { description: 'not-planted', plantedChapter: 3, payoffChapter: 4, entities: [] },
        ],
      }),
      100_000,
    );
    expect(ctx.volatile).toContain('open-now');
    expect(ctx.volatile).not.toContain('already-due');
    expect(ctx.volatile).not.toContain('not-planted');
  });
});

describe('buildNpcContext', () => {
  it("never includes another character's knowledge", () => {
    const text = buildNpcContext({
      character: tomas,
      knowledge: [
        {
          characterId: 'tomas',
          statement: 'tomas-knows-the-order',
          learnedChapter: 1,
          howLearned: 'told',
        },
        {
          characterId: 'maren',
          statement: 'maren-secret-letters',
          learnedChapter: 1,
          howLearned: 'found',
        },
      ],
      otherCharactersInScene: [{ name: 'Maren Tull', relationship: 'the keeper he must evict' }],
      recentTurns: [],
      situation: 'Maren slams the door.',
    });
    expect(text).toContain('tomas-knows-the-order');
    expect(text).not.toContain('maren-secret-letters');
  });
});

// Token size of the untrimmable part plus the stable prefix, for budget tests.
function estimateBase(): number {
  const ctx = buildDirectorContext(input({ turns: [], lockedSummaries: [], facts: [] }), 1_000_000);
  return ctx.tokens;
}

function sizeWith(statement: string): number {
  const ctx = buildDirectorContext(
    input({
      turns: [],
      lockedSummaries: [],
      facts: [{ kind: 'injury', statement, entities: ['maren'], chapter: 1 }],
    }),
    1_000_000,
  );
  return ctx.tokens;
}
