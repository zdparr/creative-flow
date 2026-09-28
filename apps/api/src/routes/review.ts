import { NotFoundError } from '@storyforge/core';
import {
  editDraft,
  getDraftVersion,
  getPlayState,
  getReview,
  lockChapter,
  recheckDraft,
  regenerateDraft,
  resolveDrift,
  unlockChapter,
  waiveIssue,
} from '@storyforge/services';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireUser } from './auth.js';

const proseBody = z.object({ prose: z.string() });
const notesBody = z.object({ notes: z.string() });
const waiveBody = z.object({ reason: z.string() });
const driftBody = z.object({ resolution: z.enum(['steer', 'adopt']) });

type ChapterParams = { Params: { id: string } };

/** Drafting, cohesion review, lock and unlock, and drift resolution for a chapter. */
export const reviewRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const { services } = deps;
  app.addHook('preHandler', requireUser(deps.env.AUTH_SECRET));

  async function loadChapter(req: FastifyRequest<ChapterParams>) {
    const found = await services.repos.chapters.getForUser(req.params.id, req.userId!);
    if (!found) throw new NotFoundError('Chapter');
    return found.chapter;
  }

  app.get<ChapterParams>('/chapters/:id/draft', async (req) =>
    getReview(services, (await loadChapter(req)).id),
  );

  app.get<{ Params: { id: string; version: string } }>(
    '/chapters/:id/draft/versions/:version',
    async (req) => {
      const chapter = await loadChapter(req);
      return getDraftVersion(services, chapter.id, Number.parseInt(req.params.version, 10));
    },
  );

  app.patch<ChapterParams>('/chapters/:id/draft', async (req) => {
    const chapter = await loadChapter(req);
    await editDraft(services, chapter.id, proseBody.parse(req.body).prose);
    return getReview(services, chapter.id);
  });

  app.post<ChapterParams>('/chapters/:id/draft/regenerate', async (req) => {
    const chapter = await loadChapter(req);
    await regenerateDraft(services, chapter.id, notesBody.parse(req.body).notes);
    return getReview(services, chapter.id);
  });

  app.post<ChapterParams>('/chapters/:id/draft/check', async (req) => {
    const chapter = await loadChapter(req);
    await recheckDraft(services, chapter.id);
    return getReview(services, chapter.id);
  });

  app.post<{ Params: { id: string; issueId: string } }>(
    '/chapters/:id/issues/:issueId/waive',
    async (req) => {
      const chapter = await loadChapter(req);
      await waiveIssue(services, chapter.id, req.params.issueId, waiveBody.parse(req.body).reason);
      return getReview(services, chapter.id);
    },
  );

  app.post<ChapterParams>('/chapters/:id/lock', async (req) => {
    const chapter = await loadChapter(req);
    await lockChapter(services, chapter.id);
    return getReview(services, chapter.id);
  });

  app.post<ChapterParams>('/chapters/:id/unlock', async (req) => {
    const chapter = await loadChapter(req);
    const result = await unlockChapter(services, chapter.id);
    return { ...result, review: await getReview(services, chapter.id) };
  });

  app.post<{ Params: { id: string; driftId: string } }>(
    '/chapters/:id/drift/:driftId',
    async (req) => {
      const chapter = await loadChapter(req);
      await resolveDrift(
        services,
        chapter.id,
        req.params.driftId,
        driftBody.parse(req.body).resolution,
      );
      return getPlayState(services, chapter.id);
    },
  );
};
