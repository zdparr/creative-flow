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
