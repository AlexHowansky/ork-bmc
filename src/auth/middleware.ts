/**
 * Request context and access control.
 *
 * Access is deny-by-default: `requireAuth` is mounted on `/`, so a newly added
 * route is unreachable to anonymous users unless it is explicitly listed as
 * public. Forgetting to guard a route fails closed.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { config } from '../config.ts';
import { forbidden, unauthorized } from '../errors.ts';
import { log } from '../log.ts';
import type { AppEnv, Theme } from '../types.ts';
import { SESSION_COOKIE, randomToken, resolveSession } from './session.ts';

export const THEME_COOKIE = 'bmc_theme';

/**
 * CSRF token for visitors who have no session yet — the sign-in form, and the
 * theme toggle on it. A session-bound token cannot exist before sign-in, so
 * these forms use a double-submit token instead: the value lives in an
 * HttpOnly cookie and is echoed in the form, and an attacker on another origin
 * can neither read the cookie nor guess the value.
 */
const ANON_CSRF_COOKIE = config.cookieSecure ? '__Host-bmc_csrf' : 'bmc_csrf';

function anonymousCsrfToken(c: Context<AppEnv>): string {
  const existing = getCookie(c, ANON_CSRF_COOKIE);
  if (existing) return existing;

  const token = randomToken();
  setCookie(c, ANON_CSRF_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    maxAge: 60 * 60 * 12,
  });
  return token;
}

/**
 * Paths reachable without a session. Everything else requires one.
 * Deliberately a fixed set: a new route is private unless it is added here.
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/logout',
  '/theme', // the toggle is available on the sign-in page
  '/healthz',
  // The one image route that answers without a session. It is not open: it
  // serves a single staged upload, to whoever holds a short-lived token that
  // only a search provider was ever given. See `/staged-image` in routes/files.
  '/staged-image',
  '/app.css',
  '/app.js',
  '/favicon.svg',
]);

/** Stamps a request id and a bound logger onto the context. */
export const requestContext = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  c.set('requestId', requestId);
  c.set('nonce', randomToken(16));
  c.set('logger', log.child({ requestId, method: c.req.method, path: c.req.path }));
  c.header('X-Request-Id', requestId);
  await next();
};

/** Resolves the session cookie, if any, without requiring one. */
export const attachSession = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const resolved = resolveSession(getCookie(c, SESSION_COOKIE));

  c.set('user', resolved?.user ?? null);
  c.set('session', resolved?.session ?? null);
  // Signed in: the token is bound to the session record. Signed out: fall back
  // to the double-submit cookie so the login form is still protected.
  c.set('csrfToken', resolved ? resolved.session.csrfToken : anonymousCsrfToken(c));

  const theme = getCookie(c, THEME_COOKIE);
  c.set('theme', theme === 'light' || theme === 'dark' ? (theme as Theme) : 'system');

  if (resolved) {
    c.set('logger', c.get('logger').child({ userId: resolved.user.id, role: resolved.user.role }));
  }

  await next();
};

export const requireAuth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();

  if (!c.get('user')) {
    // Send browsers to the login form with a return path; anything else gets a
    // plain 401 rather than a redirect it cannot follow meaningfully.
    if (c.req.method === 'GET' && c.req.header('accept')?.includes('text/html')) {
      const target = c.req.path + (new URL(c.req.url).search || '');
      return c.redirect(`/login?next=${encodeURIComponent(target)}`, 302);
    }
    throw unauthorized();
  }

  return next();
};

export const requireAdmin = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();

  if (user.role !== 'admin') {
    c.get('logger').warn('blocked non-admin from admin route', { path: c.req.path });
    throw forbidden('Only administrators can change maps.');
  }

  return next();
};
