import {
  type CardContent,
  type CohesionIssue,
  ConflictError,
  type CriticInput,
  GateError,
  NotFoundError,
  type NovelizerEvent,
  type Waiver,
  keyDialogue,
  normalizeCard,
  openBlockers,
  proseBlocks,
  ruleIssues,
  runCohesionCritic,
  runFixer,
  runNovelizer,
  draftParagraphs,
  wordCount,
} from '@storyforge/core';
import { type CharacterRow, type ChapterRow, cardsAsOf, inTransaction } from '@storyforge/db';
import { cardsForChapter, ensureCast, unapprovedCharactersIn } from './characters.js';
import type { ServiceContext } from './context.js';
import { requestReplan } from './replan.js';
import { type ChapterBasics, chapterBasics, knowledgeItems, ledgerFacts } from './state.js';

export interface NovelizeJobInput {
  projectId: string;
  chapterId: string;
  notes?: string;
}

export interface CohesionJobInput {
  projectId: string;
  chapterId: string;
  draftId: string;
}

// ---------- enqueueing ----------

export async function requestNovelize(ctx: ServiceContext, chapter: ChapterRow, notes?: string) {
  const input: NovelizeJobInput = {
    projectId: chapter.projectId,
    chapterId: chapter.id,
    ...(notes?.trim() ? { notes: notes.trim() } : {}),
  };
  const job = await ctx.repos.jobs.create(chapter.projectId, 'chapter.novelize', { ...input });
  await ctx.enqueue({ id: job.id, type: 'chapter.novelize', data: { ...input } });
  return job;
}

export async function requestCohesion(ctx: ServiceContext, chapter: ChapterRow, draftId: string) {
  const input: CohesionJobInput = { projectId: chapter.projectId, chapterId: chapter.id, draftId };
  const job = await ctx.repos.jobs.create(chapter.projectId, 'chapter.cohesion', { ...input });
  await ctx.enqueue({ id: job.id, type: 'chapter.cohesion', data: { ...input } });
  return job;
}

// ---------- shared loading ----------

/** Characters who appear in the chapter's canon scenes, plus the protagonist and planned arcs. */
async function chapterCast(ctx: ServiceContext, basics: ChapterBasics, characters: CharacterRow[]) {
  const chronicle = (await ctx.repos.play.listChronicle(basics.chapter.id)).filter(
    (e) => e.isCanon,
  );
  const ids = new Set(chronicle.flatMap((e) => e.characters));
  const named = [
    basics.bible.world.cast.find((m) => m.role === 'protagonist')?.name,
    ...basics.plan.arcsMoved.map((a) => a.character),
  ];
  for (const name of named) {
    const c = name ? ctx.repos.characters.findByName(characters, name) : undefined;
    if (c) ids.add(c.id);
  }
  return { chronicle, cast: characters.filter((c) => ids.has(c.id)) };
}

// ---------- chapter.novelize ----------

/** The chapter.novelize job: writes a new current draft from the chronicle, then queues the check. */
export async function novelizeChapter(ctx: ServiceContext, jobId: string, input: NovelizeJobInput) {
  const basics = await chapterBasics(ctx, input.chapterId);
  const { chapter, project, bible, plan } = basics;
  if (chapter.status !== 'drafting') throw new ConflictError('This chapter is not being drafted');

  const characters = await ensureCast(ctx, project.id, bible);
  const [{ chronicle, cast }, turns, locations, chapters, current] = await Promise.all([
    chapterCast(ctx, basics, characters),
    ctx.repos.play.listTurns(chapter.id),
    ctx.repos.characters.listLocations(project.id),
    ctx.repos.chapters.listForProject(project.id),
    ctx.repos.drafts.current(chapter.id),
  ]);
  if (chronicle.length === 0) throw new GateError('The chapter has no canon scenes to write from');
  const nameOf = new Map(characters.map((c) => [c.id, c.name]));
  const placeOf = new Map(locations.map((l) => [l.id, l.name]));
  const turnById = new Map(turns.map((t) => [t.id, t]));

  const events: NovelizerEvent[] = chronicle.map((e) => ({
    summary: e.summary,
    characters: e.characters.map((id) => nameOf.get(id)).filter((n): n is string => !!n),
    location: e.locationId ? (placeOf.get(e.locationId) ?? null) : null,
    interiorityNote: e.interiorityNote,
    authorNote: e.extracted.authorNote ?? null,
    dialogue: e.turnIds.flatMap((id) => {
      const turn = turnById.get(id);
      if (!turn || turn.inputKind === 'author_note') return [];
      return keyDialogue(turn.content);
    }),
  }));

  const previous = chapters.find((c) => c.number === chapter.number - 1);
  const previousDraft = previous ? await ctx.repos.drafts.current(previous.id) : null;
  const { prose } = await runNovelizer(
    ctx.agentContext(project.id, { jobId, chapterId: chapter.id }),
    {
      bible,
      chapterNumber: chapter.number,
      plan,
      events,
      cards: await cardsForChapter(ctx, project.id, cast, chapter.number),
      previousProse: previousDraft?.prose ?? null,
      targetWords: Math.round(bible.spine.targetWordCount / bible.spine.chapterCount),
      ...(input.notes ? { notes: input.notes, currentDraft: current?.prose ?? '' } : {}),
    },
  );

  const draft = await ctx.repos.drafts.create({
    projectId: project.id,
    chapterId: chapter.id,
    prose,
    wordCount: wordCount(prose),
    notes: input.notes ?? null,
    jobId,
  });
  await requestCohesion(ctx, chapter, draft.id);
  return draft.id;
}

// ---------- chapter.cohesion ----------

/**
 * Everything the book has established that a chapter draft must respect: cards as of the
 * chapter, the knowledge map, the ledger, open promises, and arc checkpoints due. The critic
 * checks against it, and the fixer revises against it so a fix does not break something else.
 */
async function cohesionContext(ctx: ServiceContext, basics: ChapterBasics, prose: string) {
  const { chapter, project, bible, plan } = basics;
  const N = chapter.number;
  const characters = await ensureCast(ctx, project.id, bible);
  const [{ chronicle, cast }, knowledge, facts, registry] = await Promise.all([
    chapterCast(ctx, basics, characters),
    knowledgeItems(ctx, project.id, N),
    ledgerFacts(ctx, project.id, N),
    ctx.repos.promises.list(project.id),
  ]);
  const cards = await cardsForChapter(ctx, project.id, cast, N);
  const nameOf = new Map(characters.map((c) => [c.id, c.name]));
  // Open as of this chapter: planted earlier and not paid before it (a recheck may see later state).
  const openPromises = registry.filter(
    (p) => p.plantedChapter < N && (p.status === 'open' || (p.paidChapter ?? 0) >= N),
  );
  const input: CriticInput = {
    bible,
    chapterNumber: N,
    plan,
    paragraphs: draftParagraphs(prose),
    cards,
    knowledge: knowledge
      .filter((k) => cast.some((c) => c.id === k.characterId))
      .map((k) => ({ ...k, character: nameOf.get(k.characterId) ?? 'unknown' })),
    openPromises: openPromises.map((p) => ({
      id: p.id,
      description: p.description,
      from: p.window.from,
      to: p.window.to,
    })),
    ledger: facts.map((f) => ({ chapter: f.chapter, kind: f.kind, statement: f.statement })),
    checkpointsDue: cards.flatMap((c) =>
      (c.card.checkpoints ?? [])
        .filter((cp) => cp.chapter <= N && !cp.met)
        .map((cp) => ({ character: c.name, chapter: cp.chapter, description: cp.description })),
    ),
    candidatePromises: chronicle.flatMap((e) => e.extracted.promises.map((p) => p.description)),
  };
  return { input, openPromises };
}

/** The chapter.cohesion job: the critic's report plus rule checks, saved against the draft. */
export async function checkCohesion(ctx: ServiceContext, jobId: string, input: CohesionJobInput) {
  const basics = await chapterBasics(ctx, input.chapterId);
  const { chapter, project, bible } = basics;
  const [draft, current] = await Promise.all([
    ctx.repos.drafts.get(input.draftId),
    ctx.repos.drafts.current(chapter.id),
  ]);
  if (!draft) throw new NotFoundError('Draft');
  // A newer draft replaced this one while the job waited; its own check will follow.
  if (current?.id !== draft.id) return 'stale';
  if (!['drafting', 'review', 'needs_recheck'].includes(chapter.status)) {
    throw new ConflictError('This chapter is not awaiting review');
  }

  const N = chapter.number;
  const { input: criticInput, openPromises } = await cohesionContext(ctx, basics, draft.prose);
  const { paragraphs } = criticInput;
  const out = await runCohesionCritic(
    ctx.agentContext(project.id, { jobId, chapterId: chapter.id }),
    criticInput,
  );

  const paid = new Set(out.paidPromiseIds);
  const rules = ruleIssues({
    paragraphs,
    bannedPhrases: bible.styleGuide.bannedPhrases,
    overdue: openPromises
      .filter((p) => p.window.to <= N && !paid.has(p.id))
      .map((p) => ({ id: p.id, description: p.description, to: p.window.to })),
  });
  const issues: CohesionIssue[] = [
    ...rules.map((i, n) => ({ ...i, id: `r${n + 1}` })),
    ...out.issues.map((i, n) => ({ ...i, id: `c${n + 1}`, source: 'critic' as const })),
  ];
  const previous = await ctx.repos.cohesion.latestForChapter(chapter.id);
  const report = await ctx.repos.cohesion.create({
    projectId: project.id,
    chapterId: chapter.id,
    draftId: draft.id,
    issues,
    summary: out.summary,
    paidPromiseIds: out.paidPromiseIds,
    plantedPromises: out.promisesPlanted,
    checkpointsMet: out.checkpointsMet,
    jobId,
  });
  // A re-check keeps the author's waivers for issues it finds again.
  const carried = carryWaivers(previous, issues);
  if (carried.length) await ctx.repos.cohesion.setWaived(report.id, carried);
  if (chapter.status === 'drafting') {
    await ctx.repos.chapters.transition(chapter.id, 'drafting', 'review');
  }
  return report.id;
}

/** Waivers from a previous report whose issue (same category and description) is found again. */
function carryWaivers(
  previous: { issues: CohesionIssue[]; waived: Waiver[] } | null,
  issues: CohesionIssue[],
): Waiver[] {
  if (!previous) return [];
  const key = (i: CohesionIssue) => `${i.category}|${i.description.trim().toLowerCase()}`;
  return previous.waived.flatMap((w) => {
    const old = previous.issues.find((i) => i.id === w.issueId);
    const again = old && issues.find((i) => key(i) === key(old));
    return again ? [{ ...w, issueId: again.id }] : [];
  });
}

// ---------- review ----------

const STAGES: Record<string, string> = {
  'chapter.novelize': 'Drafting prose',
  'chapter.cohesion': 'Checking cohesion',
};

/** Everything the Review screen shows: the draft, its report, the gates, and job progress. */
export async function getReview(ctx: ServiceContext, chapterId: string) {
  const { chapter, project, plan } = await chapterBasics(ctx, chapterId);
  const [draft, versions, report, job, pendingCards] = await Promise.all([
    ctx.repos.drafts.current(chapterId),
    ctx.repos.drafts.list(chapterId),
    ctx.repos.cohesion.latestForChapter(chapterId),
    ctx.repos.jobs.latestForChapter(chapterId, ['chapter.novelize', 'chapter.cohesion']),
    unapprovedCharactersIn(ctx, project.id, chapterId),
  ]);
  const reportCurrent = !!report && !!draft && report.draftId === draft.id;
  const blockers = report && reportCurrent ? openBlockers(report.issues, report.waived) : [];
  const working = job && (job.status === 'queued' || job.status === 'running');
  const reviewable = chapter.status === 'review' || chapter.status === 'needs_recheck';
  return {
    chapter: { id: chapter.id, number: chapter.number, status: chapter.status },
    project: { id: project.id, title: project.title, status: project.status },
    plan,
    draft: draft && {
      id: draft.id,
      version: draft.version,
      prose: draft.prose,
      wordCount: draft.wordCount,
      notes: draft.notes,
      createdAt: draft.createdAt,
    },
    paragraphs: draft ? draftParagraphs(draft.prose) : [],
    versions,
    report: report && {
      id: report.id,
      draftId: report.draftId,
      current: reportCurrent,
      issues: report.issues,
      waived: report.waived,
      summary: report.summary,
      createdAt: report.createdAt,
    },
    job: job && {
      type: job.type,
      status: job.status,
      error: job.error,
      stage: STAGES[job.type] ?? job.type,
    },
    gates: {
      pendingCards: pendingCards.map((c) => ({ id: c.id, name: c.name })),
      openBlockers: blockers.length,
      reportMissing: !reportCurrent,
    },
    canLock:
      reviewable && !working && reportCurrent && blockers.length === 0 && pendingCards.length === 0,
  };
}

export async function getDraftVersion(ctx: ServiceContext, chapterId: string, version: number) {
  const draft = await ctx.repos.drafts.getVersion(chapterId, version);
  if (!draft) throw new NotFoundError('Draft version');
  return {
    version: draft.version,
    prose: draft.prose,
    wordCount: draft.wordCount,
    notes: draft.notes,
  };
}

function assertReviewable(chapter: ChapterRow) {
  if (chapter.status !== 'review' && chapter.status !== 'needs_recheck') {
    throw new ConflictError('This chapter is not in review');
  }
}

/** An inline author edit: a new current version. Its cohesion report must be re-run before lock. */
export async function editDraft(ctx: ServiceContext, chapterId: string, prose: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  assertReviewable(chapter);
  if (!prose.trim()) throw new GateError('The draft cannot be empty');
  await ctx.repos.drafts.create({
    projectId: chapter.projectId,
    chapterId,
    prose: prose.trim(),
    wordCount: wordCount(prose),
    notes: 'Edited by the author',
    jobId: null,
  });
}

/** Regenerate with notes: back to drafting and a new novelize job. */
export async function regenerateDraft(ctx: ServiceContext, chapterId: string, notes: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  if (chapter.status === 'drafting') {
    const job = await ctx.repos.jobs.latestForChapter(chapterId, [
      'chapter.novelize',
      'chapter.cohesion',
    ]);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      throw new ConflictError('A draft is already being written');
    }
  } else {
    assertReviewable(chapter);
    if (chapter.status === 'needs_recheck') {
      await ctx.repos.chapters.transition(chapterId, 'needs_recheck', 'review');
    }
    await ctx.repos.chapters.transition(chapterId, 'review', 'drafting');
  }
  return requestNovelize(ctx, chapter, notes);
}

/** Re-runs the cohesion check on the current draft (after an inline edit). */
export async function recheckDraft(ctx: ServiceContext, chapterId: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  assertReviewable(chapter);
  const draft = await ctx.repos.drafts.current(chapterId);
  if (!draft) throw new NotFoundError('Draft');
  return requestCohesion(ctx, chapter, draft.id);
}

/** Waives an issue with a logged reason. */
export async function waiveIssue(
  ctx: ServiceContext,
  chapterId: string,
  issueId: string,
  reason: string,
) {
  if (!reason.trim()) throw new GateError('Give a reason for waiving this issue');
  const [report, draft] = await Promise.all([
    ctx.repos.cohesion.latestForChapter(chapterId),
    ctx.repos.drafts.current(chapterId),
  ]);
  if (!report || report.draftId !== draft?.id)
    throw new ConflictError('Check the current draft first');
  if (!report.issues.some((i) => i.id === issueId)) throw new NotFoundError('Issue');
  if (report.waived.some((w) => w.issueId === issueId)) return;
  await ctx.repos.cohesion.setWaived(report.id, [
    ...report.waived,
    { issueId, reason: reason.trim(), at: new Date().toISOString() },
  ]);
}

// ---------- AI fixes ----------

export interface FixProposal {
  issueId: string;
  draftVersion: number;
  explanation: string;
  edits: { paragraph: number; before: string; after: string }[];
}

/** The current draft and its report, which must match for an issue to be fixed. */
async function currentIssue(ctx: ServiceContext, chapterId: string, issueId: string) {
  const chapter = await ctx.repos.chapters.get(chapterId);
  if (!chapter) throw new NotFoundError('Chapter');
  assertReviewable(chapter);
  const [draft, report] = await Promise.all([
    ctx.repos.drafts.current(chapterId),
    ctx.repos.cohesion.latestForChapter(chapterId),
  ]);
  if (!draft || !report || report.draftId !== draft.id) {
    throw new ConflictError('Check the current draft before fixing its issues');
  }
  const issue = report.issues.find((i) => i.id === issueId);
  if (!issue) throw new NotFoundError('Issue');
  return { chapter, draft, issue, report };
}

/** Asks the fixer for revised paragraphs that resolve one issue. Nothing changes until approved. */
export async function proposeFix(
  ctx: ServiceContext,
  chapterId: string,
  issueId: string,
): Promise<FixProposal> {
  const { chapter, draft, issue, report } = await currentIssue(ctx, chapterId, issueId);
  const { input: context } = await cohesionContext(
    ctx,
    await chapterBasics(ctx, chapterId),
    draft.prose,
  );
  const { paragraphs } = context;
  const waived = new Set(report.waived.map((w) => w.issueId));
  const out = await runFixer(ctx.agentContext(chapter.projectId, { chapterId }), {
    context,
    issue,
    otherIssues: report.issues.filter((i) => i.id !== issueId && !waived.has(i.id)),
  });
  return {
    issueId,
    draftVersion: draft.version,
    explanation: out.explanation,
    edits: out.edits.map((e) => ({
      paragraph: e.paragraph,
      before: paragraphs[e.paragraph - 1]!,
      after: e.text,
    })),
  };
}

/** Replaces the nth paragraph (1-based, scene breaks not counted), keeping the prose's shape. */
export function replaceParagraphs(prose: string, edits: Map<number, string>): string {
  let n = 0;
  return proseBlocks(prose)
    .map((b) => {
      if (b.kind === 'break') return '#';
      n += 1;
      return edits.get(n) ?? b.text;
    })
    .join('\n\n');
}

/**
 * The author approves a fix (possibly after editing it): the draft gets a new version with
 * those paragraphs replaced, and the cohesion check re-runs on it.
 */
export async function applyFix(
  ctx: ServiceContext,
  chapterId: string,
  issueId: string,
  approved: { draftVersion: number; edits: { paragraph: number; text: string }[] },
) {
  const { chapter, draft, issue } = await currentIssue(ctx, chapterId, issueId);
  if (approved.draftVersion !== draft.version) {
    throw new ConflictError('The draft changed after this fix was proposed; ask for a new one');
  }
  const count = draftParagraphs(draft.prose).length;
  const edits = new Map<number, string>();
  for (const e of approved.edits) {
    const text = e.text.replace(/\s*\n\s*/g, ' ').trim();
    if (e.paragraph < 1 || e.paragraph > count) throw new GateError(`No paragraph ${e.paragraph}`);
    if (!text) throw new GateError(`Paragraph ${e.paragraph} cannot be empty`);
    edits.set(e.paragraph, text);
  }
  if (edits.size === 0) throw new GateError('The fix changes nothing');
  const prose = replaceParagraphs(draft.prose, edits);
  const next = await ctx.repos.drafts.create({
    projectId: chapter.projectId,
    chapterId,
    prose,
    wordCount: wordCount(prose),
    notes: `Fixed ${issue.paragraph > 0 ? `¶${issue.paragraph} ` : ''}(${issue.category})`,
    jobId: null,
  });
  await requestCohesion(ctx, chapter, next.id);
}

// ---------- lock ----------

/**
 * Locks a chapter. In one transaction: commits the chapter's pending ledger facts, knowledge
 * entries, promise registry changes, and card versions (arc checkpoints met); writes the
 * summary; snapshots all project state; and sets the chapter locked. Then queues the re-plan.
 */
export async function lockChapter(ctx: ServiceContext, chapterId: string) {
  const review = await getReview(ctx, chapterId);
  const { chapter, project, bible } = await chapterBasics(ctx, chapterId);
  assertReviewable(chapter);
  const problems = [
    ...(review.gates.reportMissing ? ['The current draft has not been checked for cohesion'] : []),
    ...(review.gates.openBlockers
      ? [`${review.gates.openBlockers} blocker(s) not fixed or waived`]
      : []),
    ...review.gates.pendingCards.map((c) => `${c.name}'s card is not approved`),
  ];
  if (problems.length) throw new GateError('This chapter cannot lock yet', problems);

  const N = chapter.number;
  const [report, characters, locations, chronicle, existingFacts, registry, versions] =
    await Promise.all([
      ctx.repos.cohesion.latestForChapter(chapterId),
      ctx.repos.characters.list(project.id),
      ctx.repos.characters.listLocations(project.id),
      ctx.repos.play.listChronicle(chapterId),
      ctx.repos.ledger.listActive(project.id),
      ctx.repos.promises.list(project.id),
      ctx.repos.characters.listVersionsForProject(project.id),
    ]);
  const entityIds = (names: string[]) => [
    ...new Set(
      names.flatMap((n) => {
        const c = ctx.repos.characters.findByName(characters, n);
        const l = locations.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
        return [c?.id, l?.id].filter((id): id is string => !!id);
      }),
    ),
  ];
  const already = new Set(
    existingFacts.filter((f) => f.chapterId === chapterId).map((f) => f.statement.toLowerCase()),
  );
  const newFacts = chronicle
    .filter((e) => e.isCanon)
    .flatMap((e) =>
      e.extracted.facts
        .filter((f) => !already.has(f.statement.toLowerCase()))
        .map((f) => ({ fact: f, event: e })),
    );
  const knownPromises = new Set(
    registry.filter((p) => p.plantedChapter === N).map((p) => p.description.toLowerCase()),
  );
  const latestCards = cardsAsOf(versions, Number.MAX_SAFE_INTEGER);
  const lastChapter = N >= bible.spine.chapterCount;

  await inTransaction(ctx.db, async (repos) => {
    for (const { fact, event } of newFacts) {
      const entities = entityIds(fact.entities);
      const row = await repos.ledger.add({
        projectId: project.id,
        chapterId,
        kind: fact.kind,
        statement: fact.statement,
        entities,
      });
      // Characters in the scene witnessed it; characters named in it were involved.
      const learners = new Map<string, string>();
      for (const id of event.characters) learners.set(id, `witnessed in chapter ${N}`);
      for (const id of entities) {
        if (characters.some((c) => c.id === id) && !learners.has(id)) {
          learners.set(id, `involved in chapter ${N}`);
        }
      }
      await repos.knowledge.add(
        [...learners].map(([characterId, howLearned]) => ({
          projectId: project.id,
          characterId,
          factId: row.id,
          learnedChapter: N,
          howLearned,
        })),
      );
    }

    await repos.promises.markPaid(report!.paidPromiseIds, N);
    for (const p of report!.plantedPromises) {
      if (knownPromises.has(p.description.toLowerCase())) continue;
      await repos.promises.add({
        projectId: project.id,
        type: p.type,
        description: p.description,
        plantedChapter: N,
        window: { from: Math.min(N + 1, p.payoffChapter), to: p.payoffChapter },
        entities: [],
      });
    }

    // Arc checkpoints met produce a new card version, pending the author's approval.
    for (const met of report!.checkpointsMet) {
      const character = repos.characters.findByName(characters, met.character);
      const version = character && latestCards.get(character.id);
      if (!character || !version) continue;
      const card: CardContent = normalizeCard(version.card, character.firstChapter ?? 1);
      if (!card.checkpoints.some((cp) => cp.chapter === met.chapter && !cp.met)) continue;
      await repos.characters.createVersion({
        projectId: project.id,
        characterId: character.id,
        effectiveChapter: lastChapter ? N : N + 1,
        card: {
          ...card,
          checkpoints: card.checkpoints.map((cp) =>
            cp.chapter === met.chapter ? { ...cp, met: true } : cp,
          ),
        },
        source: 'checkpoint',
        approved: false,
      });
    }

    const snapshot = await repos.snapshots.create(project.id, chapterId, {
      chapterNumber: N,
      draftId: review.draft!.id,
      reportId: report!.id,
      chapters: (await repos.chapters.listForProject(project.id)).map((c) => ({
        number: c.number,
        status: c.number === N ? 'locked' : c.status,
      })),
      outlineVersion: (await repos.outlines.latest(project.id))?.outline.version ?? null,
      bibleVersion: (await repos.bibles.latest(project.id))?.version ?? null,
      ledger: await repos.ledger.listAll(project.id),
      promises: await repos.promises.list(project.id),
      knowledge: await repos.knowledge.list(project.id),
      characters: await repos.characters.list(project.id),
      cardVersions: await repos.characters.listVersionsForProject(project.id),
    });
    await repos.chapters.markLocked(chapterId, chapter.status, {
      summary: report!.summary,
      snapshotId: snapshot.id,
    });
  });

  if (!lastChapter) await requestReplan(ctx, project.id, N);
}
