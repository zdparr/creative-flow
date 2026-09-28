import { describe, expect, it } from 'vitest';
import { createToken, verifyToken } from './tokens.js';

const secret = 'x'.repeat(32);

describe('auth tokens', () => {
  it('round-trips a valid token', () => {
    const token = createToken('session', 'user-1', secret, 1000);
    expect(verifyToken(token, 'session', secret)).toBe('user-1');
  });

  it('rejects an expired token', () => {
    const token = createToken('session', 'user-1', secret, 1000, 0);
    expect(verifyToken(token, 'session', secret, 1000)).toBeNull();
  });

  it('rejects a tampered payload or wrong secret', () => {
    const token = createToken('session', 'user-1', secret, 1000);
    const [, sig] = token.split('.');
    const payload = { kind: 'session', sub: 'user-2', exp: Date.now() + 1000 };
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(verifyToken(forged, 'session', secret)).toBeNull();
    expect(verifyToken(token, 'session', 'y'.repeat(32))).toBeNull();
    expect(verifyToken('garbage', 'session', secret)).toBeNull();
  });
});
