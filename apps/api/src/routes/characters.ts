import { CHARACTER_TIERS, NotFoundError } from '@storyforge/core';
import {
  approveCharacter,
  editCharacter,
  getCharacter,
  listCharacters,
  mergeCharacter,
  rejectCharacter,
  requestCardDraft,
} from '@storyforge/services';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireUser } from './auth.js';

const editBody = z.object({
  name: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  tier: z.enum(CHARACTER_TIERS).optional(),
  card: z.unknown().optional(),
});
const approveBody = z.object({ card: z.unknown().optional() }).optional();
const mergeBody = z.object({ intoId: z.uuid() });
const draftBody = z.object({
  tier: z.enum(CHARACTER_TIERS).optional(),
  notes: z.string().optional(),
});

type Params = { Params: { id: string } };

export const characterRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const { services } = deps;
  app.addHook('preHandler', requireUser(deps.env.AUTH_SECRET));

  async function load(req: FastifyRequest<Params>) {
    const character = await services.repos.characters.getForUser(req.params.id, req.userId!);
    if (!character) throw new NotFoundError('Character');
    return character;
  }

  app.get<Params>('/projects/:id/characters', async (req) => {
    const project = await services.repos.projects.getForUser(req.params.id, req.userId!);
    if (!project) throw new NotFoundError('Project');
    return listCharacters(services, project.id);
  });

  app.get<Params>('/characters/:id', async (req) => getCharacter(services, await load(req)));

  app.patch<Params>('/characters/:id', async (req) => {
    const character = await load(req);
    await editCharacter(services, character, editBody.parse(req.body));
    return getCharacter(services, await load(req));
  });

  app.post<Params>('/characters/:id/approve', async (req) => {
    const character = await load(req);
    await approveCharacter(services, character, approveBody.parse(req.body ?? undefined)?.card);
    return getCharacter(services, await load(req));
  });

  app.post<Params>('/characters/:id/draft', async (req) => {
    const character = await load(req);
    const body = draftBody.parse(req.body ?? {});
    await requestCardDraft(services, character, body.tier ?? character.tier, body.notes);
    return getCharacter(services, character);
  });

  app.post<Params>('/characters/:id/merge', async (req) => {
    const character = await load(req);
    const merged = await mergeCharacter(services, character, mergeBody.parse(req.body).intoId);
    return getCharacter(services, merged);
  });

  app.post<Params>('/characters/:id/reject', async (req, reply) => {
    await rejectCharacter(services, await load(req));
    return reply.code(204).send();
  });
};
