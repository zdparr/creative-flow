import { describe, expect, it } from 'vitest';
import { parseRange, toRange } from './cohesion.js';

describe('payoff windows', () => {
  it('round-trips through Postgres int4range text forms', () => {
    expect(toRange(2, 4)).toBe('[2,4]');
    expect(parseRange('[2,5)')).toEqual({ from: 2, to: 4 });
    expect(parseRange('[3,3]')).toEqual({ from: 3, to: 3 });
    expect(parseRange('(1,4)')).toEqual({ from: 2, to: 3 });
    expect(() => parseRange('empty')).toThrow();
  });
});
