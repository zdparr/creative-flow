import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  assertChapterTransition,
  assertProjectTransition,
  canTransitionProject,
  planUnlock,
} from './transitions.js';

describe('project transitions', () => {
  it('allows the forward path', () => {
    expect(() => assertProjectTransition('intake', 'bible_review')).not.toThrow();
    expect(() => assertProjectTransition('outline_review', 'writing')).not.toThrow();
  });

  it('rejects skipping a gate', () => {
    expect(canTransitionProject('intake', 'writing')).toBe(false);
    expect(() => assertProjectTransition('bible_review', 'writing')).toThrow(
      IllegalTransitionError,
    );
  });

  it('treats complete as terminal', () => {
    expect(canTransitionProject('complete', 'writing')).toBe(false);
  });
});

describe('chapter transitions', () => {
  it('rejects locking straight from play', () => {
    expect(() => assertChapterTransition('playing', 'locked')).toThrow(IllegalTransitionError);
  });

  it('allows returning from review to play', () => {
    expect(() => assertChapterTransition('review', 'playing')).not.toThrow();
  });
});

describe('planUnlock', () => {
  const chapters = [
    { id: 'c1', number: 1, status: 'locked' as const },
    { id: 'c2', number: 2, status: 'locked' as const },
    { id: 'c3', number: 3, status: 'locked' as const },
    { id: 'c4', number: 4, status: 'playing' as const },
  ];

  it('flags later locked chapters needs_recheck', () => {
    expect(planUnlock(chapters, 2)).toEqual([
      { id: 'c2', status: 'review' },
      { id: 'c3', status: 'needs_recheck' },
    ]);
  });

  it('refuses to unlock a chapter that is not locked', () => {
    expect(() => planUnlock(chapters, 4)).toThrow(IllegalTransitionError);
  });
});
