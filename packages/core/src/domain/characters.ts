import type { CharacterTier } from '../schemas/character.js';

export interface CharacterAppearances {
  /** Distinct chapters the character appears in (canon scenes only). */
  chapters: number[];
  /** True when they appear in a scene that hit a required beat. */
  inRequiredBeat: boolean;
  /** True when a promise is attached to them. */
  inPromise: boolean;
}

export interface PromotionSuggestion {
  to: CharacterTier;
  reasons: string[];
}

const NEXT: Record<CharacterTier, CharacterTier | null> = {
  walk_on: 'minor',
  minor: 'major',
  major: null,
};

/**
 * The spec's promotion rule: suggest the next tier up when a character appears in 3 or more
 * chapters, affects a required beat, or is attached to a promise.
 */
export function suggestPromotion(
  tier: CharacterTier,
  seen: CharacterAppearances,
): PromotionSuggestion | null {
  const to = NEXT[tier];
  if (!to) return null;
  const reasons: string[] = [];
  if (seen.chapters.length >= 3) reasons.push(`appears in ${seen.chapters.length} chapters`);
  if (seen.inRequiredBeat) reasons.push('takes part in a required beat');
  if (seen.inPromise) reasons.push('is attached to a promise');
  return reasons.length ? { to, reasons } : null;
}
