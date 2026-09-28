import { createHmac, timingSafeEqual } from 'node:crypto';

// Stateless HMAC-signed tokens for the single-user magic-link login and session cookie.
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256).

type TokenKind = 'magic' | 'session';

interface TokenPayload {
  kind: TokenKind;
  sub: string;
  exp: number;
}

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function createToken(
  kind: TokenKind,
  sub: string,
  secret: string,
  ttlMs: number,
  now = Date.now(),
): string {
  const payload: TokenPayload = { kind, sub, exp: now + ttlMs };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data, secret)}`;
}

/** Returns the token subject, or null when the token is malformed, forged, expired, or the wrong kind. */
export function verifyToken(
  token: string,
  kind: TokenKind,
  secret: string,
  now = Date.now(),
): string | null {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = Buffer.from(sign(data, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as TokenPayload;
    if (payload.kind !== kind || payload.exp <= now || typeof payload.sub !== 'string') return null;
    return payload.sub;
  } catch {
    return null;
  }
}
