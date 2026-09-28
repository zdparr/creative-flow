import { createHash, timingSafeEqual } from 'node:crypto';

// Single-user login: the email and password come from AUTH_ALLOWED_EMAIL and AUTH_PASSWORD.

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison of submitted credentials against the configured ones. */
export function checkCredentials(
  submitted: { email: string; password: string },
  expected: { email: string; password: string },
): boolean {
  const emailOk = submitted.email.trim().toLowerCase() === expected.email.trim().toLowerCase();
  // Hashing first gives equal-length buffers, as timingSafeEqual requires.
  const passwordOk = timingSafeEqual(digest(submitted.password), digest(expected.password));
  return emailOk && passwordOk;
}

/** In-memory lockout: after `maxFailures` failures a key is blocked until its window ends. */
export class LoginLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= now) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= now) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
