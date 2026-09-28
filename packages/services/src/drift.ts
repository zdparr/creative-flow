import {
  ConflictError,
  type DriftNotice,
  GateError,
  NotFoundError,
  normalizeCard,
  validateOutline,
} from '@storyforge/core';
import { type DriftEvent, cardsAsOf, inTransaction } from '@storyforge/db';
import type { ServiceContext } from './context.js';
import { reviseOutline } from './replan.js';

/** Stores the extractor's drift notices for a turn; refs to facts become fact ids. */
export async function recordDrift(
  ctx: ServiceContext,
  where: { projectId: string; chapterId: string; turnId: string },
  notices: DriftNotice[],
  factRefs: Map<string, string>,
): Promise<DriftEvent[]> {
  const saved: DriftEvent[] = [];
  for (const n of notices) {
    saved.push(
      await ctx.repos.drift.create({
        ...where,
        kind: n.kind,
        description: n.description,
        details: {
          beatId: n.beatId,
          factId: n.factRef ? (factRefs.get(n.factRef) ?? null) : null,
          character: n.character,
          adoptText: n.adoptText,
        },
      }),
    );
  }
  return saved;
}

/**
 * Resolves a drift notice. Steer: the director works the plan back in on the next turns.
 * Adopt: the change is written at once into the outline (a beat), the ledger (a corrected
 * fact), the promise registry (a new thread), or the character's card (a principle change).
 */
export async function resolveDrift(
  ctx: ServiceContext,
  chapterId: string,
  driftId: string,
  resolution: 'steer' | 'adopt',
) {
  const [drift, chapter] = await Promise.all([
    ctx.repos.drift.get(driftId),
    ctx.repos.chapters.get(chapterId),
  ]);
  if (!drift || drift.chapterId !== chapterId || !chapter) throw new NotFoundError('Drift notice');
  if (drift.resolution) throw new ConflictError('This notice has already been resolved');
  if (chapter.status !== 'playing') throw new ConflictError('This chapter is not being played');
  const { projectId } = chapter;
  const N = chapter.number;
  const adoptText = drift.details.adoptText.trim();
  if (resolution === 'adopt' && !adoptText) throw new GateError('There is nothing to adopt');

  if (resolution === 'steer') {
    await ctx.repos.drift.resolve(driftId, 'steer');
    return;
  }

  // Everything the adoption needs is read before the transaction opens.
  const [outline, bible, characters, versions] = await Promise.all([
    ctx.repos.outlines.latest(projectId),
    ctx.repos.bibles.latest(projectId),
    ctx.repos.characters.list(projectId),
    ctx.repos.characters.listVersionsForProject(projectId),
  ]);
  if (!outline || !bible) throw new NotFoundError('Outline');

  await inTransaction(ctx.db, async (repos) => {
    if (!(await repos.drift.resolve(driftId, 'adopt'))) {
      throw new ConflictError('This notice has already been resolved');
    }
    switch (drift.kind) {
      case 'beat': {
        const beatId = drift.details.beatId;
        const next = outline.chapters.map((c) => {
          if (c.number !== N) return c;
          if (beatId && c.requiredBeats.some((b) => b.id === beatId)) {
            return {
              ...c,
              requiredBeats: c.requiredBeats.map((b) =>
                b.id === beatId ? { ...b, description: adoptText } : b,
              ),
            };
          }
          return { ...c, purpose: `${c.purpose} ${adoptText}`.trim() };
        });
        const problems = validateOutline(next, bible.spine);
        if (problems.length) throw new GateError('Adopting this would break the outline', problems);
        await reviseOutline(repos, projectId, next);
        // The beat now describes what happened in play, so it counts as hit.
        if (beatId)
          await repos.chapters.setManualBeats(chapter.id, [
            ...new Set([...chapter.manualBeats, beatId]),
          ]);
        break;
      }
      case 'contradiction': {
        const fact = await repos.ledger.add({
          projectId,
          chapterId: chapter.id,
          kind: 'event',
          statement: adoptText,
          entities: [],
        });
        if (drift.details.factId) await repos.ledger.supersede(drift.details.factId, fact.id);
        break;
      }
      case 'thread': {
        await repos.promises.add({
          projectId,
          type: 'open_conflict',
          description: adoptText,
          plantedChapter: N,
          window: { from: Math.min(N + 1, bible.spine.chapterCount), to: bible.spine.chapterCount },
          entities: [],
        });
        break;
      }
      case 'principle': {
        const character = drift.details.character
          ? repos.characters.findByName(characters, drift.details.character)
          : undefined;
        if (!character) throw new GateError('The character in this notice was not found');
        const current = cardsAsOf(versions, N).get(character.id);
        const card = normalizeCard(current?.card, character.firstChapter ?? 1);
        // The card records the deliberate turning point from this chapter on.
        await repos.characters.createVersion({
          projectId,
          characterId: character.id,
          effectiveChapter: N,
          card: {
            ...card,
            principles: [...card.principles, `Changed in chapter ${N}: ${adoptText}`],
          },
          source: 'drift',
          approved: true,
        });
        break;
      }
      default:
        throw new GateError(`Unknown drift kind: ${drift.kind}`);
    }
  });
}
