import { MAGIC_LINK_TTL_MS, SESSION_TTL_MS, createToken, verifyToken } from '@storyforge/core';
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

const requestBody = z.object({ email: z.email() });
const verifyQuery = z.object({ token: z.string().min(1) });

export const authRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  const secret = deps.env.AUTH_SECRET;
  const allowed = deps.env.AUTH_ALLOWED_EMAIL.toLowerCase();

  app.post('/auth/request', async (req, reply) => {
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A valid email is required' });
    const email = parsed.data.email.toLowerCase();
    // Same response either way so the endpoint does not reveal the allowed address.
    if (email === allowed) {
      const token = createToken('magic', email, secret, MAGIC_LINK_TTL_MS);
      const link = new URL('/api/auth/verify', deps.env.APP_URL);
      link.searchParams.set('token', token);
      await deps.mailer.sendMagicLink(email, link.toString());
    }
    return { ok: true };
  });

  app.get('/auth/verify', async (req, reply) => {
    const parsed = verifyQuery.safeParse(req.query);
    const email = parsed.success ? verifyToken(parsed.data.token, 'magic', secret) : null;
    if (!email || email !== allowed) return reply.redirect('/?login=expired');
    const user = await deps.users.findOrCreateByEmail(email);
    reply.setCookie(SESSION_COOKIE, createToken('session', user.id, secret, SESSION_TTL_MS), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_MS / 1000,
    });
    return reply.redirect('/');
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
