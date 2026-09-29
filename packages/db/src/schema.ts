import {
  type BookIssue,
  type CardContent,
  type ChapterPromises,
  type ChronicleExtraction,
  type CohesionIssue,
  type DriftDetails,
  type FactCorrection,
  type InterviewAnswer,
  type InterviewQuestion,
  type OutlineChapter,
  type PlantedPromise,
  type ReplanItem,
  type Spine,
  type StyleGuide,
  type Waiver,
  type World,
  CHAPTER_STATUSES,
  CHARACTER_STATUSES,
  CHARACTER_TIERS,
  DRIFT_RESOLUTIONS,
  EXPORT_FORMATS,
  JOB_STATUSES,
  PROJECT_STATUSES,
  PROMISE_STATUSES,
  PROMISE_TYPES,
  TURN_INPUT_KINDS,
  TURN_ROLES,
} from '@storyforge/core';
import {
  type AnyPgColumn,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------- enums ----------

export const projectStatus = pgEnum('project_status', PROJECT_STATUSES);
export const chapterStatus = pgEnum('chapter_status', CHAPTER_STATUSES);
export const turnRole = pgEnum('turn_role', TURN_ROLES);
export const turnInputKind = pgEnum('turn_input_kind', TURN_INPUT_KINDS);
export const characterTier = pgEnum('character_tier', CHARACTER_TIERS);
export const characterStatus = pgEnum('character_status', CHARACTER_STATUSES);
export const promiseType = pgEnum('promise_type', PROMISE_TYPES);
export const promiseStatus = pgEnum('promise_status', PROMISE_STATUSES);
export const driftResolution = pgEnum('drift_resolution', DRIFT_RESOLUTIONS);
export const jobStatus = pgEnum('job_status', JOB_STATUSES);
export const exportFormat = pgEnum('export_format', EXPORT_FORMATS);

/** Postgres int4range, kept as its text form ("[3,6)") until a phase needs richer handling. */
const int4range = customType<{ data: string }>({ dataType: () => 'int4range' });
// Drivers differ: postgres-js returns a Buffer, PGlite a Uint8Array.
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

// ---------- shared columns ----------

const id = () => uuid('id').primaryKey().defaultRandom();
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
const projectId = () =>
  uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' });

// ---------- ownership ----------

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  authProviderId: text('auth_provider_id'),
  ...timestamps(),
});

export const projects = pgTable(
  'projects',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: projectStatus('status').notNull().default('intake'),
    targetLength: integer('target_length'),
    createdFromPitch: text('created_from_pitch').notNull(),
    ...timestamps(),
  },
  (t) => [index('projects_user_idx').on(t.userId)],
);

// ---------- intake, bible, outline ----------

export const interviewRounds = pgTable(
  'interview_rounds',
  {
    id: id(),
    projectId: projectId(),
    roundNo: integer('round_no').notNull(),
    questions: jsonb('questions').$type<InterviewQuestion[]>().notNull(),
    answers: jsonb('answers').$type<InterviewAnswer[]>(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('interview_rounds_project_round_uq').on(t.projectId, t.roundNo)],
);

export const bibles = pgTable(
  'bibles',
  {
    id: id(),
    projectId: projectId(),
    version: integer('version').notNull(),
    spine: jsonb('spine').$type<Spine>().notNull(),
    world: jsonb('world').$type<World>().notNull(),
    styleGuide: jsonb('style_guide').$type<StyleGuide>().notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('bibles_project_version_uq').on(t.projectId, t.version)],
);

export const outlines = pgTable(
  'outlines',
  {
    id: id(),
    projectId: projectId(),
    version: integer('version').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('outlines_project_version_uq').on(t.projectId, t.version)],
);

export const outlineChapters = pgTable(
  'outline_chapters',
  {
    id: id(),
    projectId: projectId(),
    outlineId: uuid('outline_id')
      .notNull()
      .references(() => outlines.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    purpose: text('purpose').notNull(),
    requiredBeats: jsonb('required_beats').$type<OutlineChapter['requiredBeats']>().notNull(),
    arcsMoved: jsonb('arcs_moved').$type<OutlineChapter['arcsMoved']>().notNull(),
    isAnchor: boolean('is_anchor').notNull().default(false),
    anchorType: text('anchor_type').$type<OutlineChapter['anchorType']>(),
    // Promises planted and paid in this chapter, per the outliner's plan.
    promises: jsonb('promises')
      .$type<ChapterPromises>()
      .notNull()
      .default({ planted: [], paid: [] }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('outline_chapters_outline_number_uq').on(t.outlineId, t.number)],
);

// ---------- chapters and play ----------

export const locations = pgTable('locations', {
  id: id(),
  projectId: projectId(),
  name: text('name').notNull(),
  description: text('description'),
  firstChapter: integer('first_chapter'),
  ...timestamps(),
});

export const chapters = pgTable(
  'chapters',
  {
    id: id(),
    projectId: projectId(),
    number: integer('number').notNull(),
    outlineChapterId: uuid('outline_chapter_id').references(() => outlineChapters.id, {
      onDelete: 'set null',
    }),
    status: chapterStatus('status').notNull().default('planned'),
    summary: text('summary'),
    // Beat ids the author marked as hit by hand (the beat tracker's override).
    manualBeats: text('manual_beats').array().notNull().default([]),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedSnapshotId: uuid('locked_snapshot_id').references((): AnyPgColumn => snapshots.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('chapters_project_number_uq').on(t.projectId, t.number)],
);

export const playTurns = pgTable(
  'play_turns',
  {
    id: id(),
    projectId: projectId(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: turnRole('role').notNull(),
    inputKind: turnInputKind('input_kind'),
    content: text('content').notNull(),
    tokens: integer('tokens'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('play_turns_chapter_seq_uq').on(t.chapterId, t.seq)],
);

export const chronicleEvents = pgTable(
  'chronicle_events',
  {
    id: id(),
    projectId: projectId(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    turnIds: uuid('turn_ids').array().notNull().default([]),
    summary: text('summary').notNull(),
    characters: uuid('characters').array().notNull().default([]),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    beatIds: text('beat_ids').array().notNull().default([]),
    interiorityNote: text('interiority_note'),
    isCanon: boolean('is_canon').notNull().default(true),
    // Candidate facts, promises, and characters; pending until the chapter lock commits them.
    extracted: jsonb('extracted')
      .$type<ChronicleExtraction>()
      .notNull()
      .default({ facts: [], promises: [], newCharacters: [] }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('chronicle_events_chapter_seq_uq').on(t.chapterId, t.seq)],
);

export const chapterDrafts = pgTable(
  'chapter_drafts',
  {
    id: id(),
    projectId: projectId(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    prose: text('prose').notNull(),
    wordCount: integer('word_count').notNull(),
    // The author's notes when this version was a regeneration.
    notes: text('notes'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    isCurrent: boolean('is_current').notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex('chapter_drafts_chapter_version_uq').on(t.chapterId, t.version)],
);

export const cohesionReports = pgTable('cohesion_reports', {
  id: id(),
  projectId: projectId(),
  chapterId: uuid('chapter_id')
    .notNull()
    .references(() => chapters.id, { onDelete: 'cascade' }),
  draftId: uuid('draft_id')
    .notNull()
    .references(() => chapterDrafts.id, { onDelete: 'cascade' }),
  issues: jsonb('issues').$type<CohesionIssue[]>().notNull(),
  blockerCount: integer('blocker_count').notNull().default(0),
  waived: jsonb('waived').$type<Waiver[]>().notNull().default([]),
  // Proposals the lock commits: the chapter summary, promises paid, arc checkpoints met, and
  // corrections to the facts recorded during play.
  summary: text('summary'),
  paidPromiseIds: uuid('paid_promise_ids').array().notNull().default([]),
  plantedPromises: jsonb('planted_promises').$type<PlantedPromise[]>().notNull().default([]),
  checkpointsMet: jsonb('checkpoints_met')
    .$type<{ character: string; chapter: number }[]>()
    .notNull()
    .default([]),
  factCorrections: jsonb('fact_corrections').$type<FactCorrection[]>().notNull().default([]),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  ...timestamps(),
});

// ---------- characters and cohesion structures ----------

export const characters = pgTable('characters', {
  id: id(),
  projectId: projectId(),
  name: text('name').notNull(),
  aliases: text('aliases').array().notNull().default([]),
  tier: characterTier('tier').notNull(),
  status: characterStatus('status').notNull().default('provisional'),
  firstChapter: integer('first_chapter'),
  ...timestamps(),
});

export const characterVersions = pgTable(
  'character_versions',
  {
    id: id(),
    projectId: projectId(),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    effectiveChapter: integer('effective_chapter').notNull(),
    card: jsonb('card').$type<CardContent>().notNull(),
    // Where this version came from: bible, drafted, author, checkpoint, drift.
    source: text('source').notNull().default('drafted'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('character_versions_character_version_uq').on(t.characterId, t.version)],
);

export const ledgerFacts = pgTable(
  'ledger_facts',
  {
    id: id(),
    projectId: projectId(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    statement: text('statement').notNull(),
    entities: uuid('entities').array().notNull().default([]),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => ledgerFacts.id),
    ...timestamps(),
  },
  (t) => [index('ledger_facts_entities_idx').using('gin', t.entities)],
);

export const promises = pgTable(
  'promises',
  {
    id: id(),
    projectId: projectId(),
    type: promiseType('type').notNull(),
    description: text('description').notNull(),
    plantedChapter: integer('planted_chapter').notNull(),
    payoffWindow: int4range('payoff_window').notNull(),
    status: promiseStatus('status').notNull().default('open'),
    paidChapter: integer('paid_chapter'),
    entities: uuid('entities').array().notNull().default([]),
    ...timestamps(),
  },
  (t) => [index('promises_entities_idx').using('gin', t.entities)],
);

export const knowledgeEntries = pgTable('knowledge_entries', {
  id: id(),
  projectId: projectId(),
  characterId: uuid('character_id')
    .notNull()
    .references(() => characters.id, { onDelete: 'cascade' }),
  factId: uuid('fact_id').references(() => ledgerFacts.id, { onDelete: 'cascade' }),
  promiseId: uuid('promise_id').references(() => promises.id, { onDelete: 'cascade' }),
  learnedChapter: integer('learned_chapter').notNull(),
  howLearned: text('how_learned').notNull(),
  ...timestamps(),
});

export const driftEvents = pgTable('drift_events', {
  id: id(),
  projectId: projectId(),
  chapterId: uuid('chapter_id')
    .notNull()
    .references(() => chapters.id, { onDelete: 'cascade' }),
  turnId: uuid('turn_id').references(() => playTurns.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  details: jsonb('details')
    .$type<DriftDetails>()
    .notNull()
    .default({ beatId: null, factId: null, character: null, adoptText: '' }),
  resolution: driftResolution('resolution'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  ...timestamps(),
});

export const snapshots = pgTable('snapshots', {
  id: id(),
  projectId: projectId(),
  chapterId: uuid('chapter_id')
    .notNull()
    .references((): AnyPgColumn => chapters.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  ...timestamps(),
});

// ---------- re-plan and book review ----------

export const replanDiffs = pgTable('replan_diffs', {
  id: id(),
  projectId: projectId(),
  // Proposed after this chapter locked; applies to later chapters only.
  afterChapter: integer('after_chapter').notNull(),
  items: jsonb('items').$type<ReplanItem[]>().notNull(),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  ...timestamps(),
});

export const bookReviews = pgTable('book_reviews', {
  id: id(),
  projectId: projectId(),
  summary: text('summary').notNull(),
  issues: jsonb('issues').$type<BookIssue[]>().notNull(),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  ...timestamps(),
});

// ---------- jobs, cost, exports ----------

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    projectId: projectId(),
    // The row id doubles as the BullMQ job id, so a retried enqueue never runs twice.
    type: text('type').notNull(),
    status: jobStatus('status').notNull().default('queued'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    resultRef: text('result_ref'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [index('jobs_project_status_idx').on(t.projectId, t.status)],
);

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: id(),
    projectId: projectId(),
    agent: text('agent').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('llm_calls_project_idx').on(t.projectId)],
);

export const exports = pgTable('exports', {
  id: id(),
  projectId: projectId(),
  format: exportFormat('format').notNull(),
  fileName: text('file_name').notNull(),
  byteSize: integer('byte_size').notNull(),
  // Stored in S3 when configured; otherwise the file itself is kept here.
  s3Key: text('s3_key'),
  content: bytea('content'),
  jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  ...timestamps(),
});
