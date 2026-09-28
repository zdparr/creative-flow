import { describe, expect, it } from 'vitest';
import { type AppDeps, buildApp } from './app.js';

const credentials = { email: 'author@example.com', password: 'correct horse battery' };

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    env: {
      AUTH_SECRET: 's'.repeat(32),
      AUTH_ALLOWED_EMAIL: credentials.email,
      AUTH_PASSWORD: credentials.password,
      NODE_ENV: 'test',
    },
    pingDb: async () => {},
    users: {
      findOrCreateByEmail: async (email) => ({ id: 'user-1', email }),
      findById: async (id) => ({ id, email: credentials.email, displayName: null }),
    },
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

describe('password login', () => {
  it('signs in with the configured credentials and serves /me', async () => {
    const app = await buildApp(deps());
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { ...credentials, email: 'Author@Example.com' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === 'sf_session');
    expect(cookie).toBeDefined();

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { sf_session: cookie!.value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: 'user-1' });
  });

  it('rejects a wrong password without setting a session', async () => {
    const app = await buildApp(deps());
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { ...credentials, password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  it('locks login after five failures, even for the right password', async () => {
    const app = await buildApp(deps());
    const attempt = (password: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...credentials, password } });
    for (let i = 0; i < 5; i++) expect((await attempt('nope')).statusCode).toBe(401);
    expect((await attempt(credentials.password)).statusCode).toBe(429);
  });

  it('rejects /me without a session', async () => {
    const app = await buildApp(deps());
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });
});
