import {
  BIBLE_SECTIONS,
  NotFoundError,
  interviewAnswersSchema,
  validateSpine,
} from '@storyforge/core';
import {
  advanceInterview,
  approveBible,
  approveOutline,
  createProject,
  getBible,
  getOutline,
  regenerateSection,
  requestOutline,
  submitAnswers,
  toBibleContent,
  updateBible,
  updateOutline,
} from '@storyforge/services';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireUser } from './auth.js';

const createBody = z.object({ pitch: z.string(), title: z.string().optional() });
const answersBody = z.object({ roundId: z.string(), answers: interviewAnswersSchema });
const regenerateBody = z.object({ section: z.enum(BIBLE_SECTIONS), notes: z.string().default('') });
const outlineGenerateBody = z.object({ notes: z.string().optional() }).default({});
const outlinePatchBody = z.object({ chapters: z.unknown() });
const versionQuery = z.object({ version: z.coerce.number().int().positive().optional() });

type IdParams = { Params: { id: string } };

export const projectRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const { services } = deps;
  app.addHook('preHandler', requireUser(deps.env.AUTH_SECRET));

  /** Every project route is scoped to the signed-in user. */
  async function loadProject(req: FastifyRequest<IdParams>) {
    const project = await services.repos.projects.getForUser(req.params.id, req.userId!);
    if (!project) throw new NotFoundError('Project');
    return project;
  }

  app.get('/projects', async (req) => services.repos.projects.listForUser(req.userId!));

  app.post('/projects', async (req, reply) => {
    const body = createBody.parse(req.body);
    const project = await createProject(services, req.userId!, body.pitch, body.title);
    return reply.code(201).send(project);
  });

  app.get<IdParams>('/projects/:id', loadProject);

  // ---------- interview ----------

  app.get<IdParams>('/projects/:id/interview', async (req) => {
    const project = await loadProject(req);
    return services.repos.interview.list(project.id);
  });

  app.post<IdParams>('/projects/:id/interview/next', async (req) => {
    const project = await loadProject(req);
    return advanceInterview(services, project.id);
  });

  app.post<IdParams>('/projects/:id/interview/answers', async (req) => {
    const project = await loadProject(req);
    const body = answersBody.parse(req.body);
    return submitAnswers(services, project.id, body.roundId, body.answers);
  });

  // ---------- bible ----------

  app.get<IdParams>('/projects/:id/bible', async (req) => {
    const project = await loadProject(req);
    const { version } = versionQuery.parse(req.query);
    if (version === undefined) {
      const bible = await getBible(services, project);
      if (!bible) throw new NotFoundError('Bible');
      return bible;
    }
    const row = await services.repos.bibles.getVersion(project.id, version);
    if (!row) throw new NotFoundError('Bible version');
    return {
      version: row.version,
      approvedAt: row.approvedAt,
      content: toBibleContent(project, row),
      spineProblems: validateSpine(row.spine),
    };
  });

  app.patch<IdParams>('/projects/:id/bible', async (req) => {
    const project = await loadProject(req);
    await updateBible(services, project, req.body);
    return getBible(services, await loadProject(req));
  });

  app.post<IdParams>('/projects/:id/bible/regenerate', async (req) => {
    const project = await loadProject(req);
    const body = regenerateBody.parse(req.body);
    await regenerateSection(services, project, body.section, body.notes);
    return getBible(services, project);
  });

  app.post<IdParams>('/projects/:id/bible/approve', async (req) => {
    const project = await loadProject(req);
    const job = await approveBible(services, project);
    return { jobId: job.id };
  });

  // ---------- outline ----------

  app.post<IdParams>('/projects/:id/outline/generate', async (req) => {
    const project = await loadProject(req);
    const body = outlineGenerateBody.parse(req.body ?? {});
    const job = await requestOutline(services, project.id, body.notes);
    return { jobId: job.id };
  });

  app.get<IdParams>('/projects/:id/outline', async (req) => {
    const project = await loadProject(req);
    const { version } = versionQuery.parse(req.query);
    if (version === undefined) return getOutline(services, project);
    const found = await services.repos.outlines.getVersion(project.id, version);
    if (!found) throw new NotFoundError('Outline version');
    return {
      outline: {
        version: found.outline.version,
        approvedAt: found.outline.approvedAt,
        chapters: found.chapters,
        problems: [],
      },
    };
  });

  app.patch<IdParams>('/projects/:id/outline', async (req) => {
    const project = await loadProject(req);
    await updateOutline(services, project, outlinePatchBody.parse(req.body).chapters);
    return getOutline(services, project);
  });

  app.post<IdParams>('/projects/:id/outline/approve', async (req) => {
    const project = await loadProject(req);
    await approveOutline(services, project);
    return loadProject(req);
  });
};
