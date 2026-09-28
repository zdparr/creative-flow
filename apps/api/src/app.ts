import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { WebEnv } from '@storyforge/core';
import type { UserRepo } from '@storyforge/db';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';

export interface Mailer {
  sendMagicLink(email: string, link: string): Promise<void>;
}

export interface AppDeps {
  env: Pick<WebEnv, 'AUTH_SECRET' | 'AUTH_ALLOWED_EMAIL' | 'APP_URL' | 'NODE_ENV'>;
  pingDb: () => Promise<void>;
  users: UserRepo;
  mailer: Mailer;
  /** Built front end to serve; omitted in tests and when the web app has not been built. */
  webDist?: string;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(fastifyCookie);

  await app.register(
    async (api) => {
      await api.register(healthRoutes, deps);
      await api.register(authRoutes, deps);
    },
    { prefix: '/api' },
  );

  if (deps.webDist && existsSync(deps.webDist)) {
    await app.register(fastifyStatic, { root: deps.webDist });
    // SPA fallback: unknown non-API GETs serve index.html so client routing works.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
