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

/**
 * A finalized chapter as a Word document in standard manuscript format: Times New Roman 12pt,
 * double-spaced, one-inch margins, half-inch first-line indents (none after a heading or
 * scene break), and centered "#" scene breaks. Contains prose only, never play data.
 */
export async function chapterToDocx(chapter: ChapterExport): Promise<Buffer> {
  const paragraphs: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      // Chapter openings start about a third of the way down the page.
      spacing: { before: 3 * INCH },
      children: [new TextRun(`Chapter ${chapter.chapterNumber}`)],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun(chapter.chapterTitle)],
    }),
  ];

  let indent = false;
  for (const block of proseBlocks(chapter.prose)) {
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
        children: [new TextRun(block.text)],
      }),
    );
    indent = true;
  }

  const doc = new Document({
    title: `${chapter.bookTitle}, Chapter ${chapter.chapterNumber}`,
    creator: 'Story Forge',
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { spacing: { line: 480 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: INCH, right: INCH, bottom: INCH, left: INCH } },
        },
        children: paragraphs,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** A safe download file name, e.g. "the-tide-letters-chapter-01.docx". */
export function chapterFileName(bookTitle: string, chapterNumber: number): string {
  const slug =
    bookTitle
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'book';
  return `${slug}-chapter-${String(chapterNumber).padStart(2, '0')}.docx`;
}
