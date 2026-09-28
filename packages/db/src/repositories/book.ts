import type { BookIssue, ReplanItem } from '@storyforge/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.js';
import { bookReviews, exports, replanDiffs } from '../schema.js';

export type ReplanDiff = typeof replanDiffs.$inferSelect;
export type BookReview = typeof bookReviews.$inferSelect;
export type ExportRow = typeof exports.$inferSelect;

export function createReplanRepo(db: Db) {
  return {
    async create(values: {
      projectId: string;
      afterChapter: number;
      items: ReplanItem[];
      jobId: string | null;
    }): Promise<ReplanDiff> {
      const [row] = await db
        .insert(replanDiffs)
        .values({ ...values, resolvedAt: values.items.length ? null : new Date() })
        .returning();
      return row!;
    },

    async get(id: string): Promise<ReplanDiff | null> {
      const [row] = await db.select().from(replanDiffs).where(eq(replanDiffs.id, id));
      return row ?? null;
    },

    /** Diffs with items still awaiting the author, oldest first. */
    listOpen(projectId: string): Promise<ReplanDiff[]> {
      return db
        .select()
        .from(replanDiffs)
        .where(and(eq(replanDiffs.projectId, projectId), isNull(replanDiffs.resolvedAt)))
        .orderBy(replanDiffs.createdAt);
    },

    async latest(projectId: string): Promise<ReplanDiff | null> {
      const [row] = await db
        .select()
        .from(replanDiffs)
        .where(eq(replanDiffs.projectId, projectId))
        .orderBy(desc(replanDiffs.createdAt))
        .limit(1);
      return row ?? null;
    },

    async setItems(id: string, items: ReplanItem[]): Promise<void> {
      const done = items.every((i) => i.decision !== null);
      await db
        .update(replanDiffs)
        .set({ items, resolvedAt: done ? new Date() : null })
        .where(eq(replanDiffs.id, id));
    },
  };
}

export function createBookReviewRepo(db: Db) {
  return {
    async create(values: {
      projectId: string;
      summary: string;
      issues: BookIssue[];
      jobId: string | null;
    }): Promise<BookReview> {
      const [row] = await db.insert(bookReviews).values(values).returning();
      return row!;
    },

    async latest(projectId: string): Promise<BookReview | null> {
      const [row] = await db
        .select()
        .from(bookReviews)
        .where(eq(bookReviews.projectId, projectId))
        .orderBy(desc(bookReviews.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
}

export function createExportRepo(db: Db) {
  return {
    async create(values: {
      projectId: string;
      format: ExportRow['format'];
      fileName: string;
      byteSize: number;
      s3Key: string | null;
      content: Buffer | null;
      jobId: string | null;
    }): Promise<ExportRow> {
      const [row] = await db.insert(exports).values(values).returning();
      return row!;
    },

    async get(id: string): Promise<ExportRow | null> {
      const [row] = await db.select().from(exports).where(eq(exports.id, id));
      return row ?? null;
    },

    /** Every export for the project, newest first, without file contents. */
    list(projectId: string) {
      return db
        .select({
          id: exports.id,
          format: exports.format,
          fileName: exports.fileName,
          byteSize: exports.byteSize,
          createdAt: exports.createdAt,
        })
        .from(exports)
        .where(eq(exports.projectId, projectId))
        .orderBy(desc(exports.createdAt));
    },
  };
}
