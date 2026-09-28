import { describe, expect, it } from 'vitest';
import { dashViolations, withHouseStyle } from './houseStyle.js';

describe('dashViolations', () => {
  it('allows an em dash that cuts off speech at the closing quote', () => {
    expect(dashViolations('"I\'ll do better. I\'ll—" He stopped.')).toEqual([]);
    expect(dashViolations('“Wait, that’s not—” she said.')).toEqual([]);
    expect(dashViolations("'Don't—' he began.")).toEqual([]);
    // An unquoted dialogue field that is cut off.
    expect(dashViolations("I'll do better. I'll—")).toEqual([]);
  });

  it('allows hyphens inside compound words', () => {
    expect(dashViolations('Take a lamp, not a light-spell. The half-drowned coast.')).toEqual([]);
  });

  it('flags em dashes in narration and mid-dialogue', () => {
    const text =
      'Hollin studied him — the tiredness in his face — then nodded. "Take a lamp, not a light-spell—I don\'t want you spending yourself."';
    expect(dashViolations(text)).toHaveLength(3);
  });

  it('flags en dashes and spaced hyphens used as dashes', () => {
    expect(dashViolations('She waited – and waited.')).toHaveLength(1);
    expect(dashViolations('She waited - and waited.')).toHaveLength(1);
  });
});

describe('withHouseStyle', () => {
  it('appends the house rules and records both versions', () => {
    const prompt = withHouseStyle({ version: 'director@1', system: 'Narrate.' });
    expect(prompt.version).toBe('director@1+house-style@1');
    expect(prompt.system).toContain('Narrate.');
    expect(prompt.system).toContain('only for speech that is cut off');
  });
});
