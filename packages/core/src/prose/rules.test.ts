import { describe, expect, it } from 'vitest';
import { bannedPhrasesIn, draftParagraphs, proseProblems, ruleIssues, wordCount } from './rules.js';

describe('draft rules', () => {
  it('numbers paragraphs, skipping scene breaks', () => {
    expect(draftParagraphs('One.\n\n#\n\nTwo\nlines.\n\n* * *\n\nThree.')).toEqual([
      'One.',
      'Two lines.',
      'Three.',
    ]);
    expect(wordCount(' a  b\nc ')).toBe(3);
  });

  it('finds banned phrases case-insensitively', () => {
    expect(bannedPhrasesIn('Suddenly, the door.', ['suddenly', 'a breath she held'])).toEqual([
      'suddenly',
    ]);
  });

  it('lists problems for a prose retry', () => {
    expect(proseProblems('"Wait—" she said. Fine.', [])).toEqual([]);
    expect(proseProblems('She waited — and waited. Suddenly.', ['suddenly'])).toHaveLength(2);
  });

  it('turns rule violations into report issues', () => {
    const issues = ruleIssues({
      paragraphs: ['Clean.', 'She waited — and waited.', 'Suddenly it rained.'],
      bannedPhrases: ['suddenly'],
      overdue: [{ id: 'p1', description: 'Who wrote the letters?', to: 2 }],
    });
    expect(issues.map((i) => [i.category, i.severity, i.paragraph])).toEqual([
      ['style', 'warning', 2],
      ['style', 'warning', 3],
      ['promise', 'blocker', 0],
    ]);
    expect(issues.every((i) => i.source === 'rules')).toBe(true);
  });
});
