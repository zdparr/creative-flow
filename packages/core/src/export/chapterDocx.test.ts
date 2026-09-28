import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { chapterFileName, chapterToDocx, proseBlocks } from './chapterDocx.js';

const prose = [
  'The tide came in the way it always had, without asking.',
  'She read the date twice,\nthen a third time.',
  '* * *',
  'Morning found her at the lamp.',
].join('\n\n');

describe('proseBlocks', () => {
  it('splits paragraphs, joins wrapped lines, and finds scene breaks', () => {
    expect(proseBlocks(prose)).toEqual([
      { kind: 'para', text: 'The tide came in the way it always had, without asking.' },
      { kind: 'para', text: 'She read the date twice, then a third time.' },
      { kind: 'break' },
      { kind: 'para', text: 'Morning found her at the lamp.' },
    ]);
  });
});

describe('chapterToDocx', () => {
  it('produces a Word file containing the heading and prose', async () => {
    const buffer = await chapterToDocx({
      bookTitle: 'The Tide Letters',
      chapterNumber: 1,
      chapterTitle: 'New Moon',
      prose,
    });
    // A .docx is a zip archive; check the signature, then the XML inside it.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Chapter 1');
    expect(xml).toContain('New Moon');
    expect(xml).toContain('without asking.');
    expect(xml).toContain('She read the date twice, then a third time.');
    expect(await zip.file('word/styles.xml')!.async('string')).toContain('Times New Roman');
    expect(xml).not.toContain('* * *');
  });
});

describe('chapterFileName', () => {
  it('slugs the title and pads the chapter number', () => {
    expect(chapterFileName('The Tide Letters!', 3)).toBe('the-tide-letters-chapter-03.docx');
    expect(chapterFileName('???', 12)).toBe('book-chapter-12.docx');
  });
});
