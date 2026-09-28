import type { OutlineChapter } from '../schemas/outline.js';

export interface BeatStatus {
  id: string;
  description: string;
  hit: boolean;
  /** How the beat was marked: detected in play, or set by the author. */
  source: 'play' | 'author' | null;
}

/**
 * The beat tracker. A beat is hit when a canon chronicle event records it or the author marks
 * it by hand; the author's mark wins, so a missed detection never blocks the chapter.
 */
export function beatStatus(
  plan: Pick<OutlineChapter, 'requiredBeats'>,
  canonBeatIds: readonly string[],
  manualBeats: readonly string[],
): BeatStatus[] {
  const detected = new Set(canonBeatIds);
  const manual = new Set(manualBeats);
  return plan.requiredBeats.map((b) => {
    const source = manual.has(b.id) ? 'author' : detected.has(b.id) ? 'play' : null;
    return { id: b.id, description: b.description, hit: source !== null, source };
  });
}

export const allBeatsHit = (beats: readonly BeatStatus[]) => beats.every((b) => b.hit);
