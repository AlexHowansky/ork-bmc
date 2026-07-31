/**
 * CSRF protection, layer two.
 *
 * Layer one is `hono/csrf`, which validates Origin / Sec-Fetch-Site. This adds
 * a synchroniser token bound to the session: every form carries a hidden
 * `_csrf` field that must match the value stored server-side. Origin checking
 * alone relies on headers a browser is trusted to send; the token does not.
 */
import type { Context, MiddlewareHandler } from 'hono';

import { safeEqual } from '../auth/session.ts';
import { forbidden } from '../errors.ts';
import type { AppEnv } from '../types.ts';

export const CSRF_FIELD = '_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function extractToken(c: Context<AppEnv>): Promise<string | undefined> {
  const headerToken = c.req.header(CSRF_HEADER);
  if (headerToken) return headerToken;

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('form-urlencoded') && !contentType.includes('multipart/form-data')) {
    return undefined;
  }

  // Hono caches the parsed body, so the route handler can call parseBody()
  // again without re-reading the stream.
  const body = await c.req.parseBody();
  const value = body[CSRF_FIELD];
  return typeof value === 'string' ? value : undefined;
}

export const csrfToken = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  // Signed in, this is the session token; signed out, the double-submit cookie.
  // Either way an absent value is a failed check, never a pass.
  const expected = c.get('csrfToken');
  if (!expected) {
    throw forbidden('Your session has expired. Please sign in again and retry.');
  }

  const provided = await extractToken(c);
  if (!provided || !safeEqual(provided, expected)) {
    c.get('logger').warn('csrf check failed', { hasToken: Boolean(provided) });
    throw forbidden('This form has expired. Please reload the page and try again.');
  }

  return next();
};
