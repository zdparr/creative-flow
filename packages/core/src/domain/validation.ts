import type { Spine } from '../schemas/bible.js';
import type { OutlineChapter } from '../schemas/outline.js';

/**
 * Spine completeness, the gate on bible approval. Returns human-readable problems;
 * an empty list means the spine can be approved.
 *
 * The spec lists four standard anchors "plus optional others" but asks for 3-5 in all;
 * we require the inciting incident and climax and 3-5 anchors total (see PLAN.md).
 */
export function validateSpine(spine: Spine): string[] {
  const problems: string[] = [];
  const blank = (s: string | undefined) => !s || s.trim() === '';

  if (blank(spine.centralQuestion)) problems.push('Central dramatic question is empty');
  if (blank(spine.theme)) problems.push('Theme statement is empty');
  if (blank(spine.ending?.resolution)) problems.push('Ending resolution is empty');
  if (blank(spine.ending?.cost)) problems.push('Ending cost is empty');
  if (!Number.isInteger(spine.chapterCount) || spine.chapterCount < 1) {
    problems.push('Chapter count must be at least 1');
  }

  const anchors = spine.anchorBeats ?? [];
  if (anchors.length < 3 || anchors.length > 5) {
    problems.push(`Needs 3-5 anchor beats (has ${anchors.length})`);
  }
  for (const required of ['inciting_incident', 'climax'] as const) {
    if (!anchors.some((a) => a.type === required)) {
      problems.push(`Missing anchor beat: ${required.replace('_', ' ')}`);
    }
  }
  anchors.forEach((a, i) => {
    const name = a.label || `Anchor ${i + 1}`;
    if (blank(a.description)) problems.push(`${name}: description is empty`);
    if (
      !Number.isInteger(a.targetChapter) ||
      a.targetChapter < 1 ||
      a.targetChapter > spine.chapterCount
    ) {
      problems.push(`${name}: target chapter must be between 1 and ${spine.chapterCount}`);
    }
  });
  return problems;
}

/** Structural checks on an outline against the approved spine. Empty list means valid. */
export function validateOutline(chapters: OutlineChapter[], spine: Spine): string[] {
  const problems: string[] = [];

  if (chapters.length !== spine.chapterCount) {
    problems.push(
      `Outline has ${chapters.length} chapters; the spine calls for ${spine.chapterCount}`,
    );
  }
  chapters.forEach((c, i) => {
    if (c.number !== i + 1) problems.push(`Chapter at position ${i + 1} is numbered ${c.number}`);
    if (c.requiredBeats.length === 0) problems.push(`Chapter ${c.number} has no required beats`);
    if (c.isAnchor !== (c.anchorType !== null)) {
      problems.push(`Chapter ${c.number}: isAnchor and anchorType disagree`);
    }
    for (const p of c.promises.planted) {
      if (p.payoffChapter <= c.number || p.payoffChapter > chapters.length) {
        problems.push(
          `Chapter ${c.number}: promise "${p.description}" pays off in chapter ${p.payoffChapter}, which is not a later chapter`,
        );
      }
    }
  });

  const beatIds = chapters.flatMap((c) => c.requiredBeats.map((b) => b.id));
  const dupes = beatIds.filter((id, i) => beatIds.indexOf(id) !== i);
  if (dupes.length) problems.push(`Duplicate beat ids: ${[...new Set(dupes)].join(', ')}`);

  // Anchor beats never move without an explicit author edit of the spine.
  for (const anchor of spine.anchorBeats) {
    const chapter = chapters.find((c) => c.number === anchor.targetChapter);
    if (!chapter || !chapter.isAnchor || chapter.anchorType !== anchor.type) {
      problems.push(
        `Anchor "${anchor.label}" (${anchor.type}) must be marked in chapter ${anchor.targetChapter}`,
      );
    }
  }
  return problems;
}
