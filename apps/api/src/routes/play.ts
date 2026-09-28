import { NotFoundError } from '@storyforge/core';
import {
  endChapter,
  exportChapterDocx,
  getPlayState,
  reopenChapter,
  retryTurn,
  setBeat,
  setCanon,
  startChapter,
  submitTurn,
} from '@storyforge/services';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { streamTurn } from '../sse.js';
import { requireUser } from './auth.js';

const turnBody = z.object({
  kind: z.enum(['in_character', 'author_note']),
  text: z.string(),
  interiority: z.string().optional(),
});
const beatBody = z.object({ hit: z.boolean() });
const canonBody = z.object({ isCanon: z.boolean() });

type ChapterParams = { Params: { id: string } };

export const playRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const { services } = deps;
  app.addHook('preHandler', requireUser(deps.env.AUTH_SECRET));

  /** Every chapter route is scoped to the signed-in user's projects. */
  async function loadChapter(req: FastifyRequest<ChapterParams>) {
    const found = await services.repos.chapters.getForUser(req.params.id, req.userId!);
    if (!found) throw new NotFoundError('Chapter');
    return found.chapter;
  }

  app.get<{ Params: { id: string } }>('/projects/:id/chapters', async (req) => {
    const project = await services.repos.projects.getForUser(req.params.id, req.userId!);
    if (!project) throw new NotFoundError('Project');
    return services.repos.chapters.listForProject(project.id);
  });

  app.get<ChapterParams>('/chapters/:id', async (req) => {
    const chapter = await loadChapter(req);
    return getPlayState(services, chapter.id);
  });

  app.post<ChapterParams>('/chapters/:id/start', async (req, reply) => {
    const chapter = await loadChapter(req);
    await streamTurn(req, reply, (sink) => startChapter(services, chapter.id, sink));
  });

  app.post<ChapterParams>('/chapters/:id/turns', async (req, reply) => {
    const chapter = await loadChapter(req);
    const body = turnBody.parse(req.body);
    await streamTurn(req, reply, (sink) =>
      submitTurn(
        services,
        chapter.id,
        { kind: body.kind, text: body.text },
        body.interiority ?? null,
        sink,
      ),
    );
  });

  app.post<ChapterParams>('/chapters/:id/turns/retry', async (req, reply) => {
    const chapter = await loadChapter(req);
    await streamTurn(req, reply, (sink) => retryTurn(services, chapter.id, sink));
  });

  app.post<{ Params: { id: string; beatId: string } }>(
    '/chapters/:id/beats/:beatId',
    async (req) => {
      const chapter = await loadChapter(req);
      await setBeat(services, chapter.id, req.params.beatId, beatBody.parse(req.body).hit);
      return getPlayState(services, chapter.id);
    },
  );

  app.patch<{ Params: { id: string; eventId: string } }>(
    '/chapters/:id/chronicle/:eventId',
    async (req) => {
      const chapter = await loadChapter(req);
      await setCanon(services, chapter.id, req.params.eventId, canonBody.parse(req.body).isCanon);
      return getPlayState(services, chapter.id);
    },
  );

  app.post<ChapterParams>('/chapters/:id/end', async (req) => {
    const chapter = await loadChapter(req);
    await endChapter(services, chapter.id);
    return getPlayState(services, chapter.id);
  });

  app.get<ChapterParams>('/chapters/:id/download.docx', async (req, reply) => {
    const chapter = await loadChapter(req);
    const { fileName, buffer } = await exportChapterDocx(services, chapter.id);
    return reply
      .header(
        'content-type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('content-disposition', `attachment; filename="${fileName}"`)
      .send(buffer);
  });

  app.post<ChapterParams>('/chapters/:id/reopen', async (req) => {
    const chapter = await loadChapter(req);
    await reopenChapter(services, chapter.id);
    return getPlayState(services, chapter.id);
  });
};
