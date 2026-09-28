import { describe, expect, it } from 'vitest';
import { loadWebEnv, loadWorkerEnv } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'a'.repeat(32),
  AUTH_ALLOWED_EMAIL: 'author@example.com',
  AUTH_PASSWORD: 'long enough password',
};

describe('env config', () => {
  it('loads a complete web env with defaults', () => {
    expect(loadWebEnv(base).PORT).toBe(3000);
  });

  it('rejects a short AUTH_SECRET', () => {
    expect(() => loadWebEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('rejects a missing or short AUTH_PASSWORD', () => {
    expect(() => loadWebEnv({ ...base, AUTH_PASSWORD: undefined })).toThrow(/AUTH_PASSWORD/);
    expect(() => loadWebEnv({ ...base, AUTH_PASSWORD: 'short' })).toThrow(/AUTH_PASSWORD/);
  });

  it('only needs database and redis for the worker', () => {
    expect(loadWorkerEnv({ DATABASE_URL: 'a', REDIS_URL: 'b' }).NODE_ENV).toBe('development');
  });
});
