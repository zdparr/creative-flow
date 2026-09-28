import { describe, expect, it } from 'vitest';
import { LoginLimiter, checkCredentials } from './credentials.js';

const expected = { email: 'author@example.com', password: 'correct horse' };

describe('checkCredentials', () => {
  it('accepts matching credentials, ignoring email case and spaces', () => {
    expect(
      checkCredentials({ email: ' Author@Example.com', password: 'correct horse' }, expected),
    ).toBe(true);
  });

  it('rejects a wrong password or email', () => {
    expect(checkCredentials({ email: 'author@example.com', password: 'wrong' }, expected)).toBe(
      false,
    );
    expect(
      checkCredentials({ email: 'other@example.com', password: 'correct horse' }, expected),
    ).toBe(false);
  });
});

describe('LoginLimiter', () => {
  it('blocks after the failure limit and unblocks when the window ends', () => {
    const limiter = new LoginLimiter(2, 1000);
    limiter.recordFailure('ip', 0);
    expect(limiter.isBlocked('ip', 0)).toBe(false);
    limiter.recordFailure('ip', 0);
    expect(limiter.isBlocked('ip', 500)).toBe(true);
    expect(limiter.isBlocked('ip', 1000)).toBe(false);
  });

  it('clears failures on reset', () => {
    const limiter = new LoginLimiter(1, 1000);
    limiter.recordFailure('ip', 0);
    limiter.reset('ip');
    expect(limiter.isBlocked('ip', 0)).toBe(false);
  });
});
