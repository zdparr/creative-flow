import {
  type BibleContent,
  type ChronicleExtraction,
  type Commitment,
  type ContextCommitment,
  type ContextFact,
  type ContextPromise,
  type KnowledgeItem,
  NotFoundError,
  type OutlineChapter,
} from '@storyforge/core';
import type { ChapterRow, CharacterRow, Project } from '@storyforge/db';
import { toBibleContent } from './bible.js';
import type { ServiceContext } from './context.js';

// Readers for the book's committed state (ledger, knowledge map, promise registry), shared
// by play, drafting, and re-planning.

type PlanRow = NonNullable<Awaited<ReturnType<ServiceContext['repos']['chapters']['plan']>>>;

export function toPlan(row: PlanRow): OutlineChapter {
  return {
    number: row.number,
    title: row.title,
    purpose: row.purpose,
    requiredBeats: row.requiredBeats,
    arcsMoved: row.arcsMoved,
    isAnchor: row.isAnchor,
    anchorType: row.anchorType ?? null,
    promises: row.promises,
  };
}

export interface ChapterBasics {
  chapter: ChapterRow;
  project: Project;
  bible: BibleContent;
  plan: OutlineChapter;
}

export async function chapterBasics(
  ctx: ServiceContext,
  chapterId: string,
): Promise<ChapterBasics> {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  const [project, planRow, bibleRow] = await Promise.all([
    ctx.repos.projects.get(chapter.projectId),
    ctx.repos.chapters.plan(chapter),
    ctx.repos.bibles.latest(chapter.projectId),
  ]);
  if (!project || !planRow || !bibleRow) throw new NotFoundError('Chapter plan');
  return { chapter, project, bible: toBibleContent(project, bibleRow), plan: toPlan(planRow) };
}

/** Chapter number by chapter id, for rows that store only the id. */
export async function chapterNumbers(ctx: ServiceContext, projectId: string) {
  const chapters = await ctx.repos.chapters.listForProject(projectId);
  return new Map(chapters.map((c) => [c.id, c.number]));
}

/** Active ledger facts, optionally only those committed before a chapter. */
export async function ledgerFacts(
  ctx: ServiceContext,
  projectId: string,
  beforeChapter = Number.MAX_SAFE_INTEGER,
): Promise<(ContextFact & { id: string })[]> {
  const [facts, numbers] = await Promise.all([
    ctx.repos.ledger.listActive(projectId),
    chapterNumbers(ctx, projectId),
  ]);
  return facts
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      statement: f.statement,
      entities: f.entities,
      chapter: numbers.get(f.chapterId) ?? 0,
    }))
    .filter((f) => f.chapter < beforeChapter);
}

/** The knowledge map as statements, optionally only what was learned before a chapter. */
export async function knowledgeItems(
  ctx: ServiceContext,
  projectId: string,
  beforeChapter = Number.MAX_SAFE_INTEGER,
): Promise<KnowledgeItem[]> {
  const [entries, facts, promises] = await Promise.all([
    ctx.repos.knowledge.list(projectId),
    ctx.repos.ledger.listAll(projectId),
    ctx.repos.promises.list(projectId),
  ]);
  const byId = new Map(facts.map((f) => [f.id, f]));
  // A superseded fact is known as the fact that replaced it (a corrected name, say).
  const current = (id: string) => {
    let fact = byId.get(id);
    for (let hops = 0; fact?.supersededBy && hops < facts.length; hops++) {
      fact = byId.get(fact.supersededBy);
    }
    return fact?.statement;
  };
  const promiseById = new Map(promises.map((p) => [p.id, p.description]));
  return entries
    .filter((e) => e.learnedChapter < beforeChapter)
    .map((e) => ({
      characterId: e.characterId,
      statement:
        (e.factId && current(e.factId)) || (e.promiseId && promiseById.get(e.promiseId)) || '',
      learnedChapter: e.learnedChapter,
      howLearned: e.howLearned,
    }))
    .filter((k) => k.statement);
}

export type CommitmentInForce = ContextCommitment & { id: string | null };

/**
 * Commitments given before a chapter that are still in force there: active ones, plus any a
 * later chapter broke or released (a recheck of this chapter sees them as they stood).
 */
export async function commitmentsInForce(
  ctx: ServiceContext,
  projectId: string,
  beforeChapter: number,
): Promise<CommitmentInForce[]> {
  const [rows, numbers] = await Promise.all([
    ctx.repos.commitments.list(projectId),
    chapterNumbers(ctx, projectId),
  ]);
  const chapterOf = (r: { chapterId: string }) => numbers.get(r.chapterId) ?? 0;
  return rows
    .filter(
      (r) =>
        chapterOf(r) < beforeChapter &&
        (r.status === 'active' || r.testedChapters.some((t) => t >= beforeChapter)),
    )
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      from: r.giver,
      to: r.recipients,
      content: r.content,
      scope: r.scope,
      words: r.words,
      chapter: chapterOf(r),
      tested: r.testedChapters.filter((t) => t < beforeChapter),
      entities: r.entities,
    }));
}

/** Commitments given during a chapter's canon play, not yet committed (one per content). */
export function pendingCommitments(
  ctx: ServiceContext,
  chapterNumber: number,
  chronicle: { isCanon: boolean; extracted: ChronicleExtraction }[],
  characters: CharacterRow[],
): CommitmentInForce[] {
  return asCommitments(
    ctx,
    chapterNumber,
    chronicle.filter((e) => e.isCanon).flatMap((e) => e.extracted.commitments ?? []),
    characters,
  );
}

/** Recorded commitments (from play or the critic) as context, one per content. */
export function asCommitments(
  ctx: ServiceContext,
  chapterNumber: number,
  list: Commitment[],
  characters: CharacterRow[],
): CommitmentInForce[] {
  const seen = new Set<string>();
  const idOf = (name: string) => ctx.repos.characters.findByName(characters, name)?.id;
  return list
    .filter((c) => {
      const key = c.content.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => ({
      id: null,
      kind: c.kind,
      from: c.from,
      to: c.to,
      content: c.content,
      scope: c.scope,
      words: c.words,
      chapter: chapterNumber,
      tested: [],
      entities: [...new Set([c.from, ...c.to].map(idOf).filter((id): id is string => !!id))],
    }));
}

/**
 * Promises the director should keep alive: open registry entries, plus setups the outline
 * plans for this chapter or later that have not been committed yet.
 */
export async function promisesForPlay(
  ctx: ServiceContext,
  projectId: string,
  chapterNumber: number,
): Promise<ContextPromise[]> {
  const [registry, outline] = await Promise.all([
    ctx.repos.promises.list(projectId),
    ctx.repos.outlines.latest(projectId),
  ]);
  const open = registry
    .filter((p) => p.status === 'open')
    .map((p) => ({
      description: p.description,
      plantedChapter: p.plantedChapter,
      payoffChapter: p.window.to,
      entities: p.entities,
    }));
  const known = new Set(registry.map((p) => p.description.toLowerCase()));
  const planned = (outline?.chapters ?? [])
    .filter((c) => c.number >= chapterNumber)
    .flatMap((c) =>
      c.promises.planted
        .filter((p) => !known.has(p.description.toLowerCase()))
        .map((p) => ({
          description: p.description,
          plantedChapter: c.number,
          payoffChapter: p.payoffChapter,
          entities: [],
        })),
    );
  return [...open, ...planned];
}
