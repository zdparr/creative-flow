import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEEPEN_MAX_GROWTH,
  DEEPEN_MIN_PARAGRAPH_RETAINED,
  DEEPEN_MIN_RETAINED,
  DEEPEN_TARGET_GROWTH,
} from '../agents/deepener.js';
import { lcsLength, proseWords, retention } from './retention.js';

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../fixtures/weakest-light/${name}.txt`, import.meta.url)),
    'utf8',
  );

describe('retention', () => {
  it('ignores punctuation, case, and italic markers', () => {
    expect(proseWords('*Not today,* he thought. Why the mountain?')).toEqual([
      'not',
      'today',
      'he',
      'thought',
      'why',
      'the',
      'mountain',
    ]);
    expect(retention('Why a stone. Why here.', 'Why a stone? Why *here*?').retained).toBe(1);
  });

  it('counts words kept in order', () => {
    expect(lcsLength(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toBe(3);
    const r = retention('one two three four', 'one two new three four five');
    expect(r).toMatchObject({ kept: 4, retained: 1, growth: 0.5 });
  });

  // The deepening guard is calibrated on the human editor's pass over the test chapter: that
  // pass must clear it, or the guard would reject the very edit the engine is meant to make.
  it("passes the human editor's revision of the test chapter", () => {
    const original = fixture('original');
    const revised = fixture('revised');
    const r = retention(original, revised);
    expect(r.retained).toBeGreaterThanOrEqual(DEEPEN_MIN_RETAINED);
    expect(r.growth).toBeGreaterThanOrEqual(DEEPEN_TARGET_GROWTH.min);
    expect(r.growth).toBeLessThanOrEqual(DEEPEN_MAX_GROWTH);

    const before = original.split('\n\n').find((p) => p.startsWith('It came, at first.'))!;
    const after = revised.split('\n\n').find((p) => p.startsWith('The light came.'))!;
    expect(retention(before, after).retained).toBeGreaterThanOrEqual(DEEPEN_MIN_PARAGRAPH_RETAINED);
  });
});
