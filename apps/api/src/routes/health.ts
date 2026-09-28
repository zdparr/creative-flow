import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';

export const healthRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  app.get('/health', async (req, reply) => {
    try {
      await deps.pingDb();
      return { status: 'ok' };
    } catch (err) {
      req.log.error({ err }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'error', db: 'unreachable' });
    }
  });
};
