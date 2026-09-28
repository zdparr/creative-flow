import { ConflictError, GateError } from '@storyforge/core';
import { sampleBookReview } from '@storyforge/core/testing';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleBook,
  completeBook,
  downloadExport,
  getBook,
  getUsage,
  requestExport,
} from './book.js';
import type { FileStore } from './files.js';
import { unlockChapter } from './replan.js';
import {
  type TestKit,
  createTestKit,
  draftSeedChapter,
  runQueued,
  seededProject,
  waiveAndLock,
} from './testing.js';

let kit: TestKit;
beforeEach(async () => {
  kit = await createTestKit();
});
afterEach(() => kit.close());

/** The seeded 3-chapter novella, every chapter locked. */
async function lockedNovella() {
  const setup = await seededProject(kit.ctx);
  for (const n of [1, 2, 3] as const) {
    await draftSeedChapter(kit, setup.chapters[n - 1]!.id, n);
    await waiveAndLock(kit, setup.chapters[n - 1]!.id);
  }
  const project = (await kit.ctx.repos.projects.get(setup.project.id))!;
  return { ...setup, project };
}

const reload = async (id: string) => (await kit.ctx.repos.projects.get(id))!;

describe('Phase 7: assembly and export', () => {
  it('a 3-chapter novella exports cleanly in all four formats', async () => {
    const { ctx } = kit;
    const { project } = await lockedNovella();

    let book = await getBook(ctx, project);
    expect(book.canAssemble).toBe(true);
    expect(book.canExport).toBe(false);
    expect(book.totalWords).toBeGreaterThan(50);

    // Assemble: the whole-book review runs as a job.
    await assembleBook(ctx, project);
    await runQueued(kit, 'book.review', sampleBookReview);
    book = await getBook(ctx, await reload(project.id));
    expect(book.project.status).toBe('assembling');
    expect(book.review?.issues[0]).toMatchObject({ chapter: 2, category: 'pacing' });
    expect(book.canExport).toBe(true);

    const files: Record<string, Buffer> = {};
    for (const format of ['markdown', 'docx', 'epub', 'pdf'] as const) {
      await requestExport(ctx, await reload(project.id), format);
      const id = await runQueued(kit, 'book.export');
      const file = await downloadExport(ctx, project.id, id);
      if (file.kind !== 'file') throw new Error('expected a stored file');
      expect(file.fileName).toMatch(/^the-tide-letters\.(md|docx|epub|pdf)$/);
      files[format] = file.buffer;
    }

    // Markdown: title, every chapter heading, prose only (no play data).
    const md = files.markdown!.toString('utf8');
    expect(md).toMatch(/^# The Tide Letters\n/);
    expect(md).toContain('## Chapter 1: New Moon');
    expect(md).toContain('## Chapter 3: Keep the Light');
    expect(md).toContain('signed his name beneath the lie');
    // Chronicle summaries and critic output never reach the book.
    expect(md).not.toContain('delivers the order to decommission');
    expect(md).not.toContain('The tide turned and the light held.');

    // Word: a valid package with every chapter's prose.
    const docx = await JSZip.loadAsync(files.docx!);
    const documentXml = await docx.file('word/document.xml')!.async('string');
    expect(documentXml).toContain('Chapter 2');
    expect(documentXml).toContain('The light closes at the end of the month');

    // EPUB: mimetype first and uncompressed, a valid package, one file per chapter.
    const epubBytes = files.epub!;
    expect(epubBytes.subarray(30, 38).toString('ascii')).toBe('mimetype');
    expect(epubBytes.readUInt16LE(8)).toBe(0); // stored, not deflated
    const epub = await JSZip.loadAsync(epubBytes);
    expect(await epub.file('mimetype')!.async('string')).toBe('application/epub+zip');
    expect(await epub.file('META-INF/container.xml')!.async('string')).toContain(
      'OEBPS/content.opf',
    );
    const opf = await epub.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('<dc:title>The Tide Letters</dc:title>');
    expect(opf.match(/<itemref /g)).toHaveLength(4); // title page + 3 chapters
    const ch2 = await epub.file('OEBPS/chapter-02.xhtml')!.async('string');
    expect(ch2).toContain('&quot;The light closes');
    expect(await epub.file('OEBPS/nav.xhtml')!.async('string')).toContain(
      'Chapter 3: Keep the Light',
    );

    // PDF: a complete document with a title page and a page per chapter.
    const pdf = files.pdf!.toString('latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf.match(/\/Type \/Page\b/g)!.length).toBeGreaterThanOrEqual(4);

    book = await getBook(ctx, await reload(project.id));
    expect(book.exports.map((e) => e.format).sort()).toEqual(['docx', 'epub', 'markdown', 'pdf']);

    await completeBook(ctx, await reload(project.id));
    expect((await reload(project.id)).status).toBe('complete');
    await expect(unlockChapter(ctx, book.chapters[0]!.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('stores exports in S3 when a bucket is configured', async () => {
    const { project } = await lockedNovella();
    const stored: { key: string; type: string; size: number }[] = [];
    const files: FileStore = {
      put: async (key, body, type) => void stored.push({ key, type, size: body.length }),
      downloadUrl: async (key, name) => `https://s3.example/${key}?name=${name}`,
    };
    kit.ctx.files = files;
    await assembleBook(kit.ctx, project);
    await requestExport(kit.ctx, await reload(project.id), 'epub');
    const id = await runQueued(kit, 'book.export');
    expect(stored).toMatchObject([{ type: 'application/epub+zip' }]);
    expect(stored[0]!.key).toMatch(
      new RegExp(`^exports/${project.id}/.+/the-tide-letters\\.epub$`),
    );
    const file = await downloadExport(kit.ctx, project.id, id);
    expect(file).toMatchObject({ kind: 'redirect' });
  });

  it('gates assembly and export, and lets the author revise after assembling', async () => {
    const { ctx } = kit;
    const setup = await seededProject(ctx);
    const writing = await reload(setup.project.id);
    await expect(assembleBook(ctx, writing)).rejects.toBeInstanceOf(GateError);
    await expect(requestExport(ctx, writing, 'pdf')).rejects.toBeInstanceOf(ConflictError);

    const { project, chapters } = await (async () => {
      for (const n of [1, 2, 3] as const) {
        await draftSeedChapter(kit, setup.chapters[n - 1]!.id, n);
        await waiveAndLock(kit, setup.chapters[n - 1]!.id);
      }
      return { project: await reload(setup.project.id), chapters: setup.chapters };
    })();
    await assembleBook(ctx, project);
    // Unlocking a flagged chapter during assembly returns the book to writing.
    await unlockChapter(ctx, chapters[1]!.id);
    expect((await reload(project.id)).status).toBe('writing');
  });

  it('totals usage by agent and chapter', async () => {
    const { ctx } = kit;
    const { project } = await lockedNovella();
    const usage = await getUsage(ctx, project.id);
    const agents = usage.byAgent.map((a) => a.agent).sort();
    expect(agents).toEqual(['critic', 'director', 'extractor', 'novelizer', 'replanner']);
    // Each chapter carries its own play, drafting, and checking calls.
    expect(usage.byChapter.map((c) => [c.chapter, c.calls])).toEqual([
      [null, 2],
      [1, 4],
      [2, 4],
      [3, 4],
    ]);
    expect(usage.total.calls).toBe(14);
    expect(usage.total.costUsd).toBeGreaterThan(0);
  });
});
