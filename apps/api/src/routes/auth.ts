import {
  LoginLimiter,
  SESSION_TTL_MS,
  checkCredentials,
  createToken,
  verifyToken,
} from '@storyforge/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';

export const SESSION_COOKIE = 'sf_session';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

/** preHandler that rejects requests without a valid session and sets request.userId. */
export function requireUser(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const userId = token ? verifyToken(token, 'session', secret) : null;
    if (!userId) return reply.code(401).send({ error: 'Not signed in' });
    req.userId = userId;
  };
}

const loginBody = z.object({ email: z.string(), password: z.string() });

export const authRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const secret = deps.env.AUTH_SECRET;
  const expected = { email: deps.env.AUTH_ALLOWED_EMAIL, password: deps.env.AUTH_PASSWORD };
  // One global bucket: behind Render's proxy the client IP is not trustworthy, and a
  // single-user app can afford a short lockout for everyone.
  const limiter = new LoginLimiter();
  const LIMIT_KEY = 'login';

  app.post('/auth/login', async (req, reply) => {
    if (limiter.isBlocked(LIMIT_KEY)) {
      return reply.code(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success || !checkCredentials(parsed.data, expected)) {
      limiter.recordFailure(LIMIT_KEY);
      return reply.code(401).send({ error: 'Wrong email or password' });
    }
    limiter.reset(LIMIT_KEY);
    const user = await deps.users.findOrCreateByEmail(expected.email.trim().toLowerCase());
    reply.setCookie(SESSION_COOKIE, createToken('session', user.id, secret, SESSION_TTL_MS), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: requireUser(secret) }, async (req, reply) => {
    const user = await deps.users.findById(req.userId!);
    if (!user) return reply.code(401).send({ error: 'Not signed in' });
    return user;
  });
};
