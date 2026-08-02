/**
 * Server-side sessions.
 *
 * The cookie carries a 256-bit random token; the database stores only its
 * SHA-256. A stolen database backup therefore yields no usable sessions, and
 * revocation is immediate because the server owns the record.
 *
 * Two clocks bound a session: an absolute lifetime (`expires_at`) and an idle
 * timeout (`last_seen_at`). Either one lapsing ends it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { config } from '../config.ts';
import { db } from '../db/index.ts';
import { log } from '../log.ts';
import { findUserById, type User } from '../models/users.ts';

/**
 * The `__Host-` prefix is a browser-enforced guarantee that the cookie was set
 * with Secure, Path=/ and no Domain — it cannot be overwritten by a sibling
 * subdomain. It requires HTTPS, so plain-HTTP deploys fall back to a bare name.
 */
export const SESSION_COOKIE = config.cookieSecure ? '__Host-bmc_session' : 'bmc_session';

export interface Session {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  userId: row.user_id,
  csrfToken: row.csrf_token,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
});

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

/** Hashes a cookie token into the identifier stored in the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  /** The value to put in the cookie. Never persisted. */
  token: string;
  session: Session;
}

export function createSession(userId: string, meta: { userAgent?: string; ip?: string } = {}): IssuedSession {
  const token = randomToken();
  const now = Date.now();

  const session: Session = {
    id: hashToken(token),
    userId,
    csrfToken: randomToken(),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + config.sessionTtlSeconds * 1000,
  };

  db.query(
    `INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES ($id, $userId, $csrfToken, $createdAt, $lastSeenAt, $expiresAt, $userAgent, $ip)`,
  ).run({
    $id: session.id,
    $userId: session.userId,
    $csrfToken: session.csrfToken,
    $createdAt: session.createdAt,
    $lastSeenAt: session.lastSeenAt,
    $expiresAt: session.expiresAt,
    $userAgent: meta.userAgent?.slice(0, 400) ?? null,
    $ip: meta.ip ?? null,
  });

  return { token, session };
}

export interface ResolvedSession {
  session: Session;
  user: User;
}

/**
 * Looks up a session by cookie token, enforcing both expiry clocks and
 * refreshing the idle timer. Returns null for anything unusable.
 */
export function resolveSession(token: string | undefined): ResolvedSession | null {
  if (!token) return null;

  const row = db.query('SELECT * FROM sessions WHERE id = ?').get(hashToken(token)) as SessionRow | null;
  if (!row) return null;

  const session = toSession(row);
  const now = Date.now();

  if (now >= session.expiresAt || now - session.lastSeenAt >= config.sessionIdleSeconds * 1000) {
    destroySession(session.id);
    log.debug('session expired', { userId: session.userId });
    return null;
  }

  const user = findUserById(session.userId);
  if (!user) {
    // The account was deleted while the session was live.
    destroySession(session.id);
    return null;
  }

  // Throttle the write: refreshing on every request would mean a database
  // write per page view for no benefit.
  if (now - session.lastSeenAt > 60_000) {
    db.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, session.id);
    session.lastSeenAt = now;
  }

  return { session, user };
}

export function destroySession(sessionId: string): void {
  db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function destroySessionsForUser(userId: string): void {
  db.query('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Removes rows whose absolute lifetime has lapsed. Called periodically. */
export function purgeExpiredSessions(): number {
  const result = db.query('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return Number(result.changes);
}

/** Compares two secrets without leaking their contents through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, and length is not a secret
  // here — both tokens are fixed-width — so an early return is fine.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sessionCookieOptions(maxAgeSeconds: number = config.sessionTtlSeconds) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax' as const,
    maxAge: maxAgeSeconds,
  };
}
