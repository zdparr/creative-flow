import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';

export interface ChapterExport {
  bookTitle: string;
  chapterNumber: number;
  chapterTitle: string;
  /** Final prose: paragraphs separated by blank lines; "***", "* * *", or "#" marks a scene break. */
  prose: string;
}

const INCH = 1440; // twips
const SCENE_BREAK = /^\s*(#|\*\s*\*\s*\*)\s*$/;

/** Splits prose into paragraphs and scene breaks. */
export function proseBlocks(prose: string): ({ kind: 'para'; text: string } | { kind: 'break' })[] {
  return prose
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((text) =>
      SCENE_BREAK.test(text) ? { kind: 'break' as const } : { kind: 'para' as const, text },
    );
}

/** A paragraph split into plain and italic runs; prose marks italics with single asterisks. */
export function emphasisRuns(text: string): { text: string; italic: boolean }[] {
  const runs: { text: string; italic: boolean }[] = [];
  let at = 0;
  for (const m of text.matchAll(/\*([^*\n]+)\*/g)) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index), italic: false });
    runs.push({ text: m[1]!, italic: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), italic: false });
  return runs;
}

/** A chapter's heading and prose as manuscript paragraphs. */
export function chapterParagraphs(number: number, title: string, prose: string): Paragraph[] {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      // Chapter openings start about a third of the way down the page.
      spacing: { before: 3 * INCH },
      children: [new TextRun(`Chapter ${number}`)],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun(title)],
    }),
  ];

  let indent = false;
  for (const block of proseBlocks(prose)) {
    if (block.kind === 'break') {
      paragraphs.push(
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('#')] }),
      );
      indent = false;
      continue;
    }
    paragraphs.push(
      new Paragraph({
        indent: indent ? { firstLine: INCH / 2 } : undefined,
        children: emphasisRuns(block.text).map(
          (r) => new TextRun({ text: r.text, italics: r.italic }),
        ),
      }),
    );
    indent = true;
  }
  return paragraphs;
}

const PAGE = { page: { margin: { top: INCH, right: INCH, bottom: INCH, left: INCH } } };

/**
 * Standard manuscript format: Times New Roman 12pt, double-spaced, one-inch margins. Each
 * section starts on a new page.
 */
export function manuscriptDocument(title: string, sections: Paragraph[][]): Promise<Buffer> {
  const doc = new Document({
    title,
    creator: 'Story Forge',
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { spacing: { line: 480 } },
        },
      },
    },
    sections: sections.map((children) => ({ properties: PAGE, children })),
  });
  return Packer.toBuffer(doc);
}

/**
 * A finalized chapter as a Word document in standard manuscript format, with half-inch
 * first-line indents (none after a heading or scene break) and centered "#" scene breaks.
 * Contains prose only, never play data.
 */
export function chapterToDocx(chapter: ChapterExport): Promise<Buffer> {
  return manuscriptDocument(`${chapter.bookTitle}, Chapter ${chapter.chapterNumber}`, [
    chapterParagraphs(chapter.chapterNumber, chapter.chapterTitle, chapter.prose),
  ]);
}

/** A file-name-safe slug of the book title. */
export function titleSlug(bookTitle: string): string {
  return (
    bookTitle
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'book'
  );
}

/** A safe download file name, e.g. "the-tide-letters-chapter-01.docx". */
export function chapterFileName(bookTitle: string, chapterNumber: number): string {
  return `${titleSlug(bookTitle)}-chapter-${String(chapterNumber).padStart(2, '0')}.docx`;
}
