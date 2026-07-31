/**
 * Token-bucket rate limiting, persisted in SQLite so restarts do not reset it.
 *
 * Login is limited on two independent keys — client IP and target email — so
 * neither a single noisy client nor a distributed attempt at one account can
 * grind through passwords.
 */
import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

import { config } from '../config.ts';
import { db } from '../db/index.ts';
import type { AppEnv } from '../types.ts';

interface BucketRow {
  tokens: number;
  updated_at: number;
}

export interface RateLimitOptions {
  /** Bucket capacity, and the number of tokens replenished per window. */
  capacity: number;
  windowSeconds: number;
}

const defaultOptions = (): RateLimitOptions => ({
  capacity: config.loginMaxAttempts,
  windowSeconds: config.loginWindowSeconds,
});

/**
 * Spends one token from `key`'s bucket.
 * Returns true when the caller may proceed, false when they are rate limited.
 */
export function consumeToken(key: string, options: RateLimitOptions = defaultOptions()): boolean {
  const now = Date.now();
  const refillPerMs = options.capacity / (options.windowSeconds * 1000);

  const row = db.query('SELECT tokens, updated_at FROM login_attempts WHERE key = ?').get(key) as BucketRow | null;

  const available = row
    ? Math.min(options.capacity, row.tokens + (now - row.updated_at) * refillPerMs)
    : options.capacity;

  if (available < 1) {
    // Persist the refill so the clock keeps advancing while the caller is blocked.
    db.query('UPDATE login_attempts SET tokens = ?, updated_at = ? WHERE key = ?').run(available, now, key);
    return false;
  }

  db.query(
    `INSERT INTO login_attempts (key, tokens, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
  ).run(key, available - 1, now);

  return true;
}

/** Clears a bucket. Called after a successful login so a good password resets the count. */
export function resetBucket(key: string): void {
  db.query('DELETE FROM login_attempts WHERE key = ?').run(key);
}

/** Drops buckets that have sat untouched long enough to have fully refilled. */
export function purgeStaleBuckets(windowSeconds: number = config.loginWindowSeconds): number {
  const cutoff = Date.now() - windowSeconds * 1000;
  return Number(db.query('DELETE FROM login_attempts WHERE updated_at < ?').run(cutoff).changes);
}

/**
 * Best-effort client address.
 * X-Forwarded-For is attacker-controlled unless a trusted proxy rewrites it,
 * so it is consulted only when the operator has opted in via TRUST_PROXY.
 * Otherwise the rate limiter would be trivially bypassed by spoofing a header.
 */
export function clientIp(c: Context<AppEnv>): string {
  if (config.trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    const first = forwarded?.split(',')[0]?.trim();
    if (first) return first;
  }

  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // No socket info available (e.g. under `app.request()` in tests).
    return 'unknown';
  }
}
