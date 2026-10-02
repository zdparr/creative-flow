import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { chapterFileName, chapterToDocx, emphasisRuns, proseBlocks } from './chapterDocx.js';
import { bookToEpub } from './book.js';

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

describe('italics', () => {
  const text = 'He wrote *inert* and thought, *Not now.* Then he went on.';

  it('splits a paragraph into plain and italic runs', () => {
    expect(emphasisRuns(text)).toEqual([
      { text: 'He wrote ', italic: false },
      { text: 'inert', italic: true },
      { text: ' and thought, ', italic: false },
      { text: 'Not now.', italic: true },
      { text: ' Then he went on.', italic: false },
    ]);
    expect(emphasisRuns('No markup here.')).toEqual([{ text: 'No markup here.', italic: false }]);
  });

  it('renders italics in Word and EPUB without the asterisks', async () => {
    const docx = await JSZip.loadAsync(
      await chapterToDocx({ bookTitle: 'B', chapterNumber: 1, chapterTitle: 'T', prose: text }),
    );
    const xml = await docx.file('word/document.xml')!.async('string');
    expect(xml).toMatch(/<w:i\/>[\s\S]*?inert/);
    expect(xml).not.toContain('*');

    const epub = await JSZip.loadAsync(
      await bookToEpub({
        id: 'b',
        title: 'B',
        author: '',
        chapters: [{ number: 1, title: 'T', prose: text }],
      }),
    );
    const page = await epub.file('OEBPS/chapter-01.xhtml')!.async('string');
    expect(page).toContain('He wrote <em>inert</em> and thought, <em>Not now.</em>');
  });
});
