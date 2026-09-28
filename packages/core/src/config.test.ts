import { describe, expect, it } from 'vitest';
import { loadWebEnv, loadWorkerEnv } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/x',
  REDIS_URL: 'redis://localhost:6379',
  ANTHROPIC_API_KEY: 'sk-test',
  AUTH_SECRET: 'a'.repeat(32),
  AUTH_ALLOWED_EMAIL: 'author@example.com',
  AUTH_PASSWORD: 'long enough password',
};

describe('env config', () => {
  it('loads a complete web env with defaults', () => {
    const env = loadWebEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.MODEL_FAST).toBe('claude-sonnet-5');
    expect(env.STRUCTURED_OUTPUTS).toBe(false);
  });

  it('requires an Anthropic API key', () => {
    expect(() => loadWebEnv({ ...base, ANTHROPIC_API_KEY: undefined })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('rejects a short AUTH_SECRET', () => {
    expect(() => loadWebEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('rejects a missing or short AUTH_PASSWORD', () => {
    expect(() => loadWebEnv({ ...base, AUTH_PASSWORD: undefined })).toThrow(/AUTH_PASSWORD/);
    expect(() => loadWebEnv({ ...base, AUTH_PASSWORD: 'short' })).toThrow(/AUTH_PASSWORD/);
  });

  it('does not need auth settings for the worker', () => {
    expect(
      loadWorkerEnv({ DATABASE_URL: 'a', REDIS_URL: 'b', ANTHROPIC_API_KEY: 'k' }).NODE_ENV,
    ).toBe('development');
  });
});
