import { createToken } from '@storyforge/core';
import { describe, expect, it, vi } from 'vitest';
import { type AppDeps, buildApp } from './app.js';

const secret = 's'.repeat(32);

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: {
      AUTH_SECRET: secret,
      AUTH_ALLOWED_EMAIL: 'author@example.com',
      APP_URL: 'http://localhost:3000',
      NODE_ENV: 'test',
    },
    pingDb: async () => {},
    users: {
      findOrCreateByEmail: async (email) => ({ id: 'user-1', email }),
      findById: async (id) => ({ id, email: 'author@example.com', displayName: null }),
    },
    mailer: { sendMagicLink: vi.fn(async () => {}) },
    ...overrides,
  };
}

describe('health', () => {
  it('returns ok when the database answers', async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is down', async () => {
    const app = await buildApp(
      deps({
        pingDb: async () => {
          throw new Error('down');
        },
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
  });
});

describe('magic link auth', () => {
  it('sends a link only to the allowed email', async () => {
    const d = deps();
    const app = await buildApp(d);
    await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: { email: 'stranger@example.com' },
    });
    expect(d.mailer.sendMagicLink).not.toHaveBeenCalled();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: { email: 'Author@Example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(d.mailer.sendMagicLink).toHaveBeenCalledOnce();
  });

  it('verifies a link, sets a session, and serves /me', async () => {
    const app = await buildApp(deps());
    const token = createToken('magic', 'author@example.com', secret, 60_000);
    const verify = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
    expect(verify.statusCode).toBe(302);
    const cookie = verify.cookies.find((c) => c.name === 'sf_session');
    expect(cookie).toBeDefined();

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { sf_session: cookie!.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: 'user-1' });
  });

  it('rejects /me without a session', async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('redirects an invalid link back to login', async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/auth/verify?token=bad' });
    expect(res.headers.location).toBe('/?login=expired');
  });
});
