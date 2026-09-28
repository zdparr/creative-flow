import { describe, expect, it } from 'vitest';
import { loadWebEnv, loadWorkerEnv } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'a'.repeat(32),
  AUTH_ALLOWED_EMAIL: 'author@example.com',
};

describe('env config', () => {
  it('falls back to RENDER_EXTERNAL_URL for APP_URL', () => {
    const env = loadWebEnv({ ...base, RENDER_EXTERNAL_URL: 'https://sf.onrender.com' });
    expect(env.APP_URL).toBe('https://sf.onrender.com');
    expect(env.PORT).toBe(3000);
  });

  it('rejects a short AUTH_SECRET', () => {
    expect(() => loadWebEnv({ ...base, AUTH_SECRET: 'short', APP_URL: 'http://x.dev' })).toThrow(
      /AUTH_SECRET/,
    );
  });

  it('only needs database and redis for the worker', () => {
    expect(loadWorkerEnv({ DATABASE_URL: 'a', REDIS_URL: 'b' }).NODE_ENV).toBe('development');
  });
});
