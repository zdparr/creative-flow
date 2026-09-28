import { describe, expect, it } from 'vitest';
import { validateOutline, validateSpine } from '../domain/validation.js';
import {
  sampleAdaCard,
  sampleBible,
  sampleInterviewBible,
  sampleInterviewRound,
  sampleMajorCard,
  sampleMinorCharacterExtraction,
  sampleNpcVoice,
  sampleOpeningExtraction,
  sampleOutline,
  sampleTurnExtraction,
} from '../testing/fixtures.js';
import {
  sampleBookReview,
  sampleReplan,
  seedBible,
  seedChapters,
  seedOutline,
  seedTomasCard,
} from '../testing/seedBook.js';
import { bibleContentSchema } from './bible.js';
import { majorCardSchema, minorCardSchema, missingCardFields, normalizeCard } from './character.js';
import { criticOutputSchema } from './cohesion.js';
import { interviewerOutputSchema } from './interview.js';
import { outlinerOutputSchema } from './outline.js';
import { extractorOutputSchema, npcVoiceOutputSchema } from './play.js';
import { bookReviewOutputSchema, replanOutputSchema } from './replan.js';

const valid = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(true);

// Every recorded agent output must validate against its schema.
describe('agent output fixtures', () => {
  it('bible', () => valid(bibleContentSchema, sampleBible));
  it('interviewer questions', () => valid(interviewerOutputSchema, sampleInterviewRound(1)));
  it('interviewer bible', () => valid(interviewerOutputSchema, sampleInterviewBible));
  it('outliner', () => valid(outlinerOutputSchema, sampleOutline));
  it('extractor', () => {
    for (const x of [
      sampleOpeningExtraction,
      sampleTurnExtraction,
      sampleMinorCharacterExtraction,
    ]) {
      valid(extractorOutputSchema, x);
    }
    for (const c of Object.values(seedChapters)) valid(extractorOutputSchema, c.extraction);
  });
  it('npc voice', () => valid(npcVoiceOutputSchema, sampleNpcVoice));
  it('card drafter', () => {
    valid(minorCardSchema, sampleAdaCard);
    valid(majorCardSchema, sampleMajorCard);
    valid(majorCardSchema, seedTomasCard);
  });
  it('cohesion critic', () => {
    for (const c of Object.values(seedChapters)) valid(criticOutputSchema, c.critic);
  });
  it('re-planner and book reviewer', () => {
    valid(replanOutputSchema, sampleReplan);
    valid(bookReviewOutputSchema, sampleBookReview);
  });
});

describe('the seeded test book', () => {
  it('has a valid spine and outline', () => {
    expect(validateSpine(seedBible.spine)).toEqual([]);
    expect(validateOutline(seedOutline.chapters, seedBible.spine)).toEqual([]);
  });
});

describe('character cards', () => {
  it('lists required fields that are empty for the tier', () => {
    const card = normalizeCard({ role: 'clerk', trait: 'kind' });
    expect(missingCardFields('walk_on', card)).toEqual([]);
    expect(missingCardFields('minor', card)).toEqual([
      'storyRole',
      'want',
      'relationshipToProtagonist',
      'voiceNote',
    ]);
    expect(missingCardFields('major', sampleMajorCard)).toEqual([]);
    expect(missingCardFields('major', { ...sampleMajorCard, principles: [' '] })).toEqual([
      'principles',
    ]);
  });

  it('reads any stored card as a full card', () => {
    expect(normalizeCard(null).principles).toEqual([]);
    expect(normalizeCard({ want: 'x' }, 3)).toMatchObject({ want: 'x', firstAppearance: 3 });
  });
});
