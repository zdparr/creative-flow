// Shapes returned by the API. Domain types come from core as type-only imports.
import type {
  BibleContent,
  BookFormat,
  BookIssue,
  CardContent,
  CharacterTier,
  CohesionIssue,
  InterviewAnswer,
  InterviewQuestion,
  OutlineChapter,
  ProjectStatus,
  ReplanItem,
  Waiver,
} from '@storyforge/core';

export type {
  BibleContent,
  BookFormat,
  CardContent,
  CharacterTier,
  CohesionIssue,
  InterviewAnswer,
  InterviewQuestion,
  OutlineChapter,
  ProjectStatus,
};

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Project {
  id: string;
  title: string;
  status: ProjectStatus;
  createdFromPitch: string;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewRound {
  id: string;
  roundNo: number;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[] | null;
}

export type InterviewStep = { kind: 'questions'; round: InterviewRound } | { kind: 'bible' };

export interface VersionInfo {
  id: string;
  version: number;
  createdAt: string;
  approvedAt: string | null;
}

export interface BibleView {
  version: number;
  approvedAt: string | null;
  content: BibleContent;
  spineProblems: string[];
  versions?: VersionInfo[];
}

export interface OutlineView {
  outline: {
    version: number;
    approvedAt: string | null;
    chapters: OutlineChapter[];
    problems: string[];
  } | null;
  versions?: VersionInfo[];
  job: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    error: string | null;
  } | null;
}

export type ChapterStatus =
  'planned' | 'playing' | 'drafting' | 'review' | 'locked' | 'needs_recheck';

export interface ChapterListItem {
  id: string;
  number: number;
  status: ChapterStatus;
  title: string | null;
  purpose: string | null;
}

export interface Beat {
  id: string;
  description: string;
  hit: boolean;
  source: 'play' | 'author' | null;
}

export interface Turn {
  id: string;
  seq: number;
  role: 'author' | 'director' | 'npc';
  inputKind: 'in_character' | 'author_note' | null;
  content: string;
}

export interface ChronicleEntry {
  id: string;
  seq: number;
  summary: string;
  isCanon: boolean;
  beatIds: string[];
  interiorityNote: string | null;
}

export interface PlayState {
  chapter: { id: string; number: number; status: ChapterStatus };
  project: { id: string; title: string; status: ProjectStatus };
  plan: OutlineChapter;
  turns: Turn[];
  chronicle: ChronicleEntry[];
  beats: Beat[];
  canEnd: boolean;
  awaitingResponse: boolean;
  sceneCharacters: { id: string; name: string; tier: string; status: string }[];
  cardTray: CharacterView[];
  drift: DriftView[];
  openPromises: { description: string; plantedChapter: number; payoffChapter: number }[];
}

// ---------- characters (Phase 4) ----------

export interface CardVersion {
  id: string;
  version: number;
  effectiveChapter: number;
  source: string;
  approvedAt: string | null;
  createdAt: string;
  card: CardContent;
}

export interface CharacterView {
  id: string;
  name: string;
  aliases: string[];
  tier: CharacterTier;
  status: 'provisional' | 'approved';
  firstChapter: number | null;
  card: CardContent;
  approvedVersion: CardVersion | null;
  pendingVersion: CardVersion | null;
  missing: (keyof CardContent)[];
  needsApproval: boolean;
  drafting: boolean;
  chapters: number[];
  promotion: { to: CharacterTier; reasons: string[] } | null;
  versions?: CardVersion[];
}

// ---------- drift (Phase 6) ----------

export interface DriftView {
  id: string;
  turnId: string | null;
  kind: 'beat' | 'contradiction' | 'thread' | 'principle';
  description: string;
  adoptText: string;
  resolution: 'steer' | 'adopt' | null;
}

// ---------- review (Phase 5) ----------

export interface JobView {
  type?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  stage?: string;
}

export interface ReviewView {
  chapter: { id: string; number: number; status: ChapterStatus };
  project: { id: string; title: string; status: ProjectStatus };
  plan: OutlineChapter;
  draft: {
    id: string;
    version: number;
    prose: string;
    wordCount: number;
    notes: string | null;
    createdAt: string;
  } | null;
  paragraphs: string[];
  versions: {
    id: string;
    version: number;
    wordCount: number;
    notes: string | null;
    isCurrent: boolean;
    createdAt: string;
  }[];
  report: {
    id: string;
    current: boolean;
    issues: CohesionIssue[];
    waived: Waiver[];
    summary: string | null;
    createdAt: string;
  } | null;
  job: JobView | null;
  gates: {
    pendingCards: { id: string; name: string }[];
    openBlockers: number;
    reportMissing: boolean;
  };
  canLock: boolean;
}

// ---------- re-plan (Phase 6) ----------

export interface ReplanView {
  diffs: { id: string; afterChapter: number; items: ReplanItem[]; createdAt: string }[];
  job: JobView | null;
}

// ---------- book (Phase 7) ----------

export interface UsageTotal {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface BookView {
  project: { id: string; title: string; status: ProjectStatus };
  chapters: {
    id: string;
    number: number;
    title: string | null;
    status: ChapterStatus;
    wordCount: number;
    lockedAt: string | null;
  }[];
  totalWords: number;
  review: { summary: string; issues: BookIssue[]; createdAt: string } | null;
  reviewJob: (JobView & { id: string }) | null;
  exports: {
    id: string;
    format: BookFormat;
    fileName: string;
    byteSize: number;
    createdAt: string;
  }[];
  exportJob: (JobView & { id: string; input: { format?: BookFormat } }) | null;
  usage: {
    total: UsageTotal;
    byAgent: (UsageTotal & { agent: string })[];
    byChapter: (UsageTotal & { chapter: number | null })[];
  };
  promises: {
    id: string;
    type: string;
    description: string;
    status: 'open' | 'paid' | 'dropped';
    plantedChapter: number;
    window: { from: number; to: number };
    paidChapter: number | null;
  }[];
  ledger: {
    id: string;
    chapter: number | null;
    kind: string;
    statement: string;
    superseded: boolean;
  }[];
  canAssemble: boolean;
  canExport: boolean;
}
