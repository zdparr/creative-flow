import { describe, expect, it } from 'vitest';
import { applyReplan, replanChangeProblems } from '../agents/replanner.js';
import { seedOutline } from '../testing/seedBook.js';
import { suggestPromotion } from './characters.js';

describe('promotion', () => {
  const none = { chapters: [1], inRequiredBeat: false, inPromise: false };

  it('suggests the next tier when a rule is met', () => {
    expect(suggestPromotion('walk_on', none)).toBeNull();
    expect(suggestPromotion('walk_on', { ...none, chapters: [1, 2, 3] })).toEqual({
      to: 'minor',
      reasons: ['appears in 3 chapters'],
    });
    expect(suggestPromotion('minor', { ...none, inRequiredBeat: true, inPromise: true })).toEqual({
      to: 'major',
      reasons: ['takes part in a required beat', 'is attached to a promise'],
    });
    expect(suggestPromotion('major', { ...none, chapters: [1, 2, 3, 4] })).toBeNull();
  });
});

describe('re-plan rules', () => {
  const [, ch2, ch3] = seedOutline.chapters;

  it('rejects changes to locked chapters and moved anchors', () => {
    expect(replanChangeProblems(ch2, { chapter: 2, after: ch2! }, 2)).toEqual([
      'chapter 2: is locked and cannot change',
    ]);
    expect(
      replanChangeProblems(ch3, { chapter: 3, after: { ...ch3!, anchorType: 'dark_moment' } }, 1),
    ).toEqual(['chapter 3: anchor beats never move; keep isAnchor and anchorType as they are']);
    expect(
      replanChangeProblems(ch3, { chapter: 3, after: { ...ch3!, purpose: 'New' } }, 1),
    ).toEqual([]);
  });

  it('applies changes by chapter number', () => {
    const next = applyReplan(seedOutline.chapters, [
      { chapter: 3, after: { ...ch3!, title: 'X' } },
    ]);
    expect(next.map((c) => c.title)).toEqual(['New Moon', 'The Inspector', 'X']);
  });
});
