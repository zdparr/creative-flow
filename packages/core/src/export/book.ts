import { AlignmentType, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import {
  chapterParagraphs,
  emphasisRuns,
  manuscriptDocument,
  proseBlocks,
  titleSlug,
} from './chapterDocx.js';

// Whole-book exports. Every format holds the locked chapters' final prose only.

export interface BookExport {
  /** Stable id for the book (EPUB identifier). */
  id: string;
  title: string;
  author: string;
  chapters: { number: number; title: string; prose: string }[];
}

export type BookFormat = 'markdown' | 'docx' | 'epub' | 'pdf';

export const FORMAT_INFO: Record<
  BookFormat,
  { extension: string; contentType: string; label: string }
> = {
  markdown: { extension: 'md', contentType: 'text/markdown; charset=utf-8', label: 'Markdown' },
  docx: {
    extension: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word',
  },
  epub: { extension: 'epub', contentType: 'application/epub+zip', label: 'EPUB' },
  pdf: { extension: 'pdf', contentType: 'application/pdf', label: 'PDF' },
};

export function bookFileName(title: string, format: BookFormat): string {
  return `${titleSlug(title)}.${FORMAT_INFO[format].extension}`;
}

export function bookToMarkdown(book: BookExport): string {
  const chapters = book.chapters.map((c) => {
    const body = proseBlocks(c.prose)
      .map((b) => (b.kind === 'break' ? '* * *' : b.text))
      .join('\n\n');
    return `## Chapter ${c.number}: ${c.title}\n\n${body}`;
  });
  return `# ${book.title}\n\n${book.author ? `by ${book.author}\n\n` : ''}${chapters.join('\n\n')}\n`;
}

export function bookToDocx(book: BookExport): Promise<Buffer> {
  const titlePage = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 4 * 1440 },
      children: [new TextRun({ text: book.title, size: 36 })],
    }),
    ...(book.author
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun(`by ${book.author}`)],
          }),
        ]
      : []),
  ];
  return manuscriptDocument(book.title, [
    titlePage,
    ...book.chapters.map((c) => chapterParagraphs(c.number, c.title, c.prose)),
  ]);
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const chapterFile = (n: number) => `chapter-${String(n).padStart(2, '0')}.xhtml`;

/** An EPUB 3 package: the mimetype first and uncompressed, then the container, package, and chapters. */
export async function bookToEpub(book: BookExport, now = new Date()): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(
    'OEBPS/style.css',
    `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1 { text-align: center; margin: 3em 0 0.5em; font-weight: normal; }
h2 { text-align: center; margin: 0 0 2em; font-weight: normal; font-style: italic; }
p { margin: 0; text-indent: 1.5em; }
p.first { text-indent: 0; }
p.break { text-align: center; text-indent: 0; margin: 1em 0; }
.title { text-align: center; margin-top: 30%; }`,
  );
  const page = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="utf-8"/><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`;

  zip.file(
    'OEBPS/title.xhtml',
    page(
      book.title,
      `<div class="title"><h1>${xml(book.title)}</h1>${book.author ? `<p class="first">by ${xml(book.author)}</p>` : ''}</div>`,
    ),
  );
  for (const c of book.chapters) {
    let first = true;
    const body = proseBlocks(c.prose)
      .map((b) => {
        if (b.kind === 'break') {
          first = true;
          return '<p class="break">#</p>';
        }
        const text = emphasisRuns(b.text)
          .map((r) => (r.italic ? `<em>${xml(r.text)}</em>` : xml(r.text)))
          .join('');
        const html = `<p${first ? ' class="first"' : ''}>${text}</p>`;
        first = false;
        return html;
      })
      .join('\n');
    zip.file(
      `OEBPS/${chapterFile(c.number)}`,
      page(
        `Chapter ${c.number}`,
        `<h1>Chapter ${c.number}</h1>\n<h2>${xml(c.title)}</h2>\n${body}`,
      ),
    );
  }
  zip.file(
    'OEBPS/nav.xhtml',
    page(
      'Contents',
      `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${book.chapters.map((c) => `<li><a href="${chapterFile(c.number)}">Chapter ${c.number}: ${xml(c.title)}</a></li>`).join('\n')}
</ol></nav>`,
    ),
  );
  const modified = `${now.toISOString().slice(0, 19)}Z`;
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${xml(book.id)}</dc:identifier>
    <dc:title>${xml(book.title)}</dc:title>
    <dc:language>en</dc:language>
    ${book.author ? `<dc:creator>${xml(book.author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${book.chapters.map((c) => `    <item id="ch${c.number}" href="${chapterFile(c.number)}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
    <itemref idref="title"/>
${book.chapters.map((c) => `    <itemref idref="ch${c.number}"/>`).join('\n')}
  </spine>
</package>`,
  );
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/epub+zip',
  });
}

/** A print-ready PDF: US Letter, one-inch margins, Times 12pt, each chapter on a new page. */
export function bookToPdf(book: BookExport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 72,
      info: {
        Title: book.title,
        ...(book.author ? { Author: book.author } : {}),
        Creator: 'Story Forge',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 144;
    doc.font('Times-Roman').fontSize(24).text(book.title, 72, 260, { align: 'center', width });
    if (book.author)
      doc.moveDown().fontSize(14).text(`by ${book.author}`, { align: 'center', width });

    for (const c of book.chapters) {
      doc.addPage();
      doc
        .font('Times-Roman')
        .fontSize(16)
        .text(`Chapter ${c.number}`, 72, 200, { align: 'center', width });
      doc.moveDown(0.5).font('Times-Italic').fontSize(14).text(c.title, { align: 'center', width });
      doc.moveDown(2).font('Times-Roman').fontSize(12);
      let first = true;
      for (const block of proseBlocks(c.prose)) {
        if (block.kind === 'break') {
          doc.moveDown(0.5).text('#', { align: 'center', width }).moveDown(0.5);
          first = true;
          continue;
        }
        const runs = emphasisRuns(block.text);
        runs.forEach((r, i) => {
          doc.font(r.italic ? 'Times-Italic' : 'Times-Roman').text(r.text, {
            width,
            align: 'justify',
            indent: first ? 0 : 24,
            lineGap: 4,
            continued: i < runs.length - 1,
          });
        });
        doc.font('Times-Roman');
        first = false;
      }
    }
    doc.end();
  });
}

/** Builds the file for a format. */
export async function renderBook(book: BookExport, format: BookFormat): Promise<Buffer> {
  switch (format) {
    case 'markdown':
      return Buffer.from(bookToMarkdown(book), 'utf8');
    case 'docx':
      return bookToDocx(book);
    case 'epub':
      return bookToEpub(book);
    case 'pdf':
      return bookToPdf(book);
  }
}
