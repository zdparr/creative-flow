import { describe, expect, it } from 'vitest';
import { sampleBible, sampleOutline } from '../testing/fixtures.js';
import { validateOutline, validateSpine } from './validation.js';

describe('validateSpine', () => {
  it('accepts a complete spine', () => {
    expect(validateSpine(sampleBible.spine)).toEqual([]);
  });

  it('reports empty fields and missing anchors', () => {
    const problems = validateSpine({
      ...sampleBible.spine,
      theme: ' ',
      ending: { resolution: 'She wins', cost: '' },
      anchorBeats: sampleBible.spine.anchorBeats.filter((a) => a.type !== 'climax').slice(0, 2),
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        'Theme statement is empty',
        'Ending cost is empty',
        'Needs 3-5 anchor beats (has 2)',
        'Missing anchor beat: climax',
      ]),
    );
  });

  it('rejects anchors outside the chapter range', () => {
    const [first, ...rest] = sampleBible.spine.anchorBeats;
    const problems = validateSpine({
      ...sampleBible.spine,
      anchorBeats: [{ ...first!, targetChapter: 99 }, ...rest],
    });
    expect(problems.some((p) => p.includes('target chapter'))).toBe(true);
  });
});

describe('validateOutline', () => {
  it('accepts an outline that honors the spine', () => {
    expect(validateOutline(sampleOutline.chapters, sampleBible.spine)).toEqual([]);
  });

  it('flags a moved anchor and a wrong chapter count', () => {
    const chapters = sampleOutline.chapters
      .slice(0, -1)
      .map((c) =>
        c.anchorType === 'inciting_incident' ? { ...c, isAnchor: false, anchorType: null } : c,
      );
    const problems = validateOutline(chapters, sampleBible.spine);
    expect(problems.some((p) => p.includes('the spine calls for'))).toBe(true);
    expect(problems.some((p) => p.includes('inciting_incident'))).toBe(true);
  });

  it('flags a promise that pays off before it is planted', () => {
    const chapters = structuredClone(sampleOutline.chapters);
    chapters[2]!.promises.planted.push({ description: 'Backwards', type: 'vow', payoffChapter: 1 });
    expect(validateOutline(chapters, sampleBible.spine).some((p) => p.includes('Backwards'))).toBe(
      true,
    );
  });
});
