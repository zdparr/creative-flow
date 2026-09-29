import type {
  CohesionIssue,
  DriftDetails,
  FactCorrection,
  PlantedPromise,
  Waiver,
} from '@storyforge/core';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  cohesionReports,
  driftEvents,
  knowledgeEntries,
  ledgerFacts,
  promises,
  snapshots,
} from '../schema.js';

export type CohesionReport = typeof cohesionReports.$inferSelect;
export type LedgerFact = typeof ledgerFacts.$inferSelect;
export type KnowledgeEntry = typeof knowledgeEntries.$inferSelect;
export type PromiseRow = typeof promises.$inferSelect;
export type DriftEvent = typeof driftEvents.$inferSelect;

/** Payoff windows are int4range; Postgres stores "[3,5]" as "[3,6)". */
export const toRange = (from: number, to: number) => `[${from},${to}]`;
export function parseRange(range: string): { from: number; to: number } {
  const m = /^([[(])(\d+),(\d+)([\])])$/.exec(range.trim());
  if (!m) throw new Error(`Unreadable payoff window: ${range}`);
  const from = Number(m[2]) + (m[1] === '(' ? 1 : 0);
  const to = Number(m[3]) - (m[4] === ')' ? 1 : 0);
  return { from, to };
}

/** A promise with its window parsed. */
export const promiseView = (p: PromiseRow) => ({ ...p, window: parseRange(p.payoffWindow) });
export type PromiseView = ReturnType<typeof promiseView>;

export function createCohesionRepo(db: Db) {
  return {
    async create(values: {
      projectId: string;
      chapterId: string;
      draftId: string;
      issues: CohesionIssue[];
      summary: string;
      paidPromiseIds: string[];
      plantedPromises: PlantedPromise[];
      checkpointsMet: { character: string; chapter: number }[];
      factCorrections?: FactCorrection[];
      jobId: string | null;
    }): Promise<CohesionReport> {
      const [row] = await db
        .insert(cohesionReports)
        .values({
          ...values,
          blockerCount: values.issues.filter((i) => i.severity === 'blocker').length,
        })
        .returning();
      return row!;
    },

    /** The newest report for the chapter, whichever draft it checked. */
    async latestForChapter(chapterId: string): Promise<CohesionReport | null> {
      const [row] = await db
        .select()
        .from(cohesionReports)
        .where(eq(cohesionReports.chapterId, chapterId))
        .orderBy(desc(cohesionReports.createdAt))
        .limit(1);
      return row ?? null;
    },

    async setWaived(id: string, waived: Waiver[]): Promise<void> {
      await db.update(cohesionReports).set({ waived }).where(eq(cohesionReports.id, id));
    },
  };
}

export function createLedgerRepo(db: Db) {
  return {
    /** Facts not superseded, oldest first. */
    listActive(projectId: string): Promise<LedgerFact[]> {
      return db
        .select()
        .from(ledgerFacts)
        .where(and(eq(ledgerFacts.projectId, projectId), isNull(ledgerFacts.supersededBy)))
        .orderBy(asc(ledgerFacts.createdAt));
    },

    listAll(projectId: string): Promise<LedgerFact[]> {
      return db
        .select()
        .from(ledgerFacts)
        .where(eq(ledgerFacts.projectId, projectId))
        .orderBy(asc(ledgerFacts.createdAt));
    },

    async get(id: string): Promise<LedgerFact | null> {
      const [row] = await db.select().from(ledgerFacts).where(eq(ledgerFacts.id, id));
      return row ?? null;
    },

    async add(values: {
      projectId: string;
      chapterId: string;
      kind: string;
      statement: string;
      entities: string[];
    }): Promise<LedgerFact> {
      const [row] = await db.insert(ledgerFacts).values(values).returning();
      return row!;
    },

    /** Append-only: a fact is never deleted, only superseded by a later one. */
    async supersede(id: string, byId: string): Promise<void> {
      await db.update(ledgerFacts).set({ supersededBy: byId }).where(eq(ledgerFacts.id, id));
    },
  };
}

export function createKnowledgeRepo(db: Db) {
  return {
    list(projectId: string): Promise<KnowledgeEntry[]> {
      return db
        .select()
        .from(knowledgeEntries)
        .where(eq(knowledgeEntries.projectId, projectId))
        .orderBy(asc(knowledgeEntries.learnedChapter));
    },

    async add(
      values: {
        projectId: string;
        characterId: string;
        factId?: string | null;
        promiseId?: string | null;
        learnedChapter: number;
        howLearned: string;
      }[],
    ): Promise<void> {
      if (values.length) await db.insert(knowledgeEntries).values(values);
    },
  };
}

export function createPromiseRepo(db: Db) {
  return {
    async list(projectId: string): Promise<PromiseView[]> {
      const rows = await db
        .select()
        .from(promises)
        .where(eq(promises.projectId, projectId))
        .orderBy(asc(promises.plantedChapter), asc(promises.createdAt));
      return rows.map(promiseView);
    },

    async add(values: {
      projectId: string;
      type: PromiseRow['type'];
      description: string;
      plantedChapter: number;
      window: { from: number; to: number };
      entities: string[];
    }): Promise<PromiseRow> {
      const { window, ...rest } = values;
      const [row] = await db
        .insert(promises)
        .values({ ...rest, payoffWindow: toRange(window.from, window.to) })
        .returning();
      return row!;
    },

    async markPaid(ids: string[], chapter: number): Promise<void> {
      if (!ids.length) return;
      await db
        .update(promises)
        .set({ status: 'paid', paidChapter: chapter })
        .where(and(inArray(promises.id, ids), eq(promises.status, 'open')));
    },

    async setStatus(id: string, status: PromiseRow['status']): Promise<void> {
      await db.update(promises).set({ status }).where(eq(promises.id, id));
    },

    async setWindow(id: string, from: number, to: number): Promise<void> {
      await db
        .update(promises)
        .set({ payoffWindow: toRange(from, to) })
        .where(eq(promises.id, id));
    },
  };
}

export function createSnapshotRepo(db: Db) {
  return {
    async create(projectId: string, chapterId: string, payload: Record<string, unknown>) {
      const [row] = await db
        .insert(snapshots)
        .values({ projectId, chapterId, payload })
        .returning();
      return row!;
    },
  };
}

export function createDriftRepo(db: Db) {
  return {
    async create(values: {
      projectId: string;
      chapterId: string;
      turnId: string | null;
      kind: string;
      description: string;
      details: DriftDetails;
    }): Promise<DriftEvent> {
      const [row] = await db.insert(driftEvents).values(values).returning();
      return row!;
    },

    async get(id: string): Promise<DriftEvent | null> {
      const [row] = await db.select().from(driftEvents).where(eq(driftEvents.id, id));
      return row ?? null;
    },

    listForChapter(chapterId: string): Promise<DriftEvent[]> {
      return db
        .select()
        .from(driftEvents)
        .where(eq(driftEvents.chapterId, chapterId))
        .orderBy(asc(driftEvents.createdAt));
    },

    listForProject(projectId: string): Promise<DriftEvent[]> {
      return db
        .select()
        .from(driftEvents)
        .where(eq(driftEvents.projectId, projectId))
        .orderBy(asc(driftEvents.createdAt));
    },

    /** Resolves an unresolved notice; returns false if it was already resolved. */
    async resolve(id: string, resolution: 'steer' | 'adopt'): Promise<boolean> {
      const updated = await db
        .update(driftEvents)
        .set({ resolution, resolvedAt: new Date() })
        .where(and(eq(driftEvents.id, id), isNull(driftEvents.resolution)))
        .returning({ id: driftEvents.id });
      return updated.length > 0;
    },
  };
}
