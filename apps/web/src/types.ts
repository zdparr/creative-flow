// Shapes returned by the API. Domain types come from core as type-only imports.
import type {
  BibleContent,
  InterviewAnswer,
  InterviewQuestion,
  OutlineChapter,
  ProjectStatus,
} from '@storyforge/core';

export type { BibleContent, InterviewAnswer, InterviewQuestion, OutlineChapter, ProjectStatus };

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
  openPromises: { description: string; plantedChapter: number; payoffChapter: number }[];
}
