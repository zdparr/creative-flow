import { EXPORT_FORMATS, NotFoundError } from '@storyforge/core';
import {
  assembleBook,
  completeBook,
  decideReplanItem,
  downloadExport,
  getBook,
  getReplans,
  getUsage,
  knowledgeItems,
  requestExport,
  updatePromise,
} from '@storyforge/services';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireUser } from './auth.js';

const exportBody = z.object({ format: z.enum(EXPORT_FORMATS) });
const decisionBody = z.object({ itemId: z.string(), decision: z.enum(['accept', 'reject']) });
const promiseBody = z.object({
  status: z.enum(['open', 'dropped']).optional(),
  extendTo: z.number().int().optional(),
});

type ProjectParams = { Params: { id: string } };

/** Cohesion structures, re-plan diffs, assembly, export, and usage for a project. */
export const bookRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const { services } = deps;
  app.addHook('preHandler', requireUser(deps.env.AUTH_SECRET));

  async function loadProject(req: FastifyRequest<ProjectParams>) {
    const project = await services.repos.projects.getForUser(req.params.id, req.userId!);
    if (!project) throw new NotFoundError('Project');
    return project;
  }

  app.get<ProjectParams>('/projects/:id/book', async (req) =>
    getBook(services, await loadProject(req)),
  );

  app.get<ProjectParams>('/projects/:id/ledger', async (req) => {
    const project = await loadProject(req);
    return (await getBook(services, project)).ledger;
  });

  app.get<ProjectParams>('/projects/:id/promises', async (req) => {
    const project = await loadProject(req);
    return (await getBook(services, project)).promises;
  });

  app.patch<{ Params: { id: string; promiseId: string } }>(
    '/projects/:id/promises/:promiseId',
    async (req) => {
      const project = await loadProject(req);
      await updatePromise(services, project.id, req.params.promiseId, promiseBody.parse(req.body));
      return (await getBook(services, project)).promises;
    },
  );

  app.get<ProjectParams>('/projects/:id/knowledge', async (req) => {
    const project = await loadProject(req);
    const [items, characters] = await Promise.all([
      knowledgeItems(services, project.id),
      services.repos.characters.list(project.id),
    ]);
    const nameOf = new Map(characters.map((c) => [c.id, c.name]));
    return items.map((k) => ({ ...k, character: nameOf.get(k.characterId) ?? null }));
  });

  app.get<ProjectParams>('/projects/:id/usage', async (req) =>
    getUsage(services, (await loadProject(req)).id),
  );

  app.get<ProjectParams>('/projects/:id/replan', async (req) =>
    getReplans(services, (await loadProject(req)).id),
  );

  app.post<{ Params: { id: string; diffId: string } }>(
    '/projects/:id/replan/:diffId',
    async (req) => {
      const project = await loadProject(req);
      const body = decisionBody.parse(req.body);
      await decideReplanItem(services, project.id, req.params.diffId, body.itemId, body.decision);
      return getReplans(services, project.id);
    },
  );

  app.post<ProjectParams>('/projects/:id/assemble', async (req) => {
    const project = await loadProject(req);
    await assembleBook(services, project);
    return getBook(services, await loadProject(req));
  });

  app.post<ProjectParams>('/projects/:id/complete', async (req) => {
    const project = await loadProject(req);
    await completeBook(services, project);
    return getBook(services, await loadProject(req));
  });

  app.post<ProjectParams>('/projects/:id/export', async (req) => {
    const project = await loadProject(req);
    await requestExport(services, project, exportBody.parse(req.body).format);
    return getBook(services, project);
  });

  app.get<{ Params: { id: string; exportId: string } }>(
    '/projects/:id/exports/:exportId/download',
    async (req, reply) => {
      const project = await loadProject(req);
      const file = await downloadExport(services, project.id, req.params.exportId);
      if (file.kind === 'redirect') return reply.redirect(file.url);
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        .send(file.buffer);
    },
  );
};
