// Status values from the spec's workflow state machine. The db package builds its
// Postgres enums from these arrays so the two can never drift apart.

export const PROJECT_STATUSES = [
  'intake',
  'bible_review',
  'outline_review',
  'writing',
  'assembling',
  'complete',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const CHAPTER_STATUSES = [
  'planned',
  'playing',
  'drafting',
  'review',
  'locked',
  'needs_recheck',
] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export const TURN_ROLES = ['author', 'director', 'npc'] as const;
export const TURN_INPUT_KINDS = ['in_character', 'author_note'] as const;
export const CHARACTER_TIERS = ['walk_on', 'minor', 'major'] as const;
export const CHARACTER_STATUSES = ['provisional', 'approved'] as const;
export const PROMISE_TYPES = [
  'mystery',
  'foreshadowing',
  'planted_object',
  'open_conflict',
  'vow',
] as const;
export const PROMISE_STATUSES = ['open', 'paid', 'dropped'] as const;
export const DRIFT_RESOLUTIONS = ['steer', 'adopt'] as const;
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export const EXPORT_FORMATS = ['epub', 'docx', 'pdf', 'markdown'] as const;
