/**
 * Page rendering helpers.
 *
 * `page()` wraps content in the layout and supplies the per-request bits
 * (user, theme, CSRF token) so no route has to remember them.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Child } from 'hono/jsx';

import { config } from '../config.ts';
import type { AppEnv } from '../types.ts';
import { Layout, type Flash } from './Layout.tsx';

const FLASH_COOKIE = 'bmc_flash';

/**
 * Queues a one-shot message to show after a redirect. Stored in a short-lived
 * cookie because there is no server-side session store for view state.
 */
export function setFlash(c: Context<AppEnv>, flash: Flash): void {
  setCookie(c, FLASH_COOKIE, JSON.stringify(flash), {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    maxAge: 60,
  });
}

/** Reads and clears any queued flash message. */
function takeFlash(c: Context<AppEnv>): Flash | undefined {
  const raw = getCookie(c, FLASH_COOKIE);
  if (!raw) return undefined;

  deleteCookie(c, FLASH_COOKIE, { path: '/' });

  try {
    const parsed = JSON.parse(raw) as Flash;
    if (typeof parsed?.message !== 'string') return undefined;
    if (!['success', 'error', 'info'].includes(parsed.kind)) return undefined;
    return parsed;
  } catch {
    // A malformed cookie is not worth failing a page render over.
    return undefined;
  }
}

export interface PageOptions {
  title: string;
  status?: number;
  /** Overrides any queued flash, for errors raised during this same request. */
  flash?: Flash;
  /** Enables the map detail page's CSS grid overlay at this square count. */
  gridOverlay?: { columns: number; rows: number };
}

export function page(c: Context<AppEnv>, options: PageOptions, body: Child): Response {
  const user = c.get('user');

  // Defaults matter here: this same function renders the error page, and a
  // failure early in the middleware chain can reach it before the session
  // layer has populated the context. A missing variable must not escalate a
  // handled 403 into an unhandled 500.
  const document = (
    <Layout
      title={options.title}
      theme={c.get('theme') ?? 'system'}
      user={user ? { email: user.email, role: user.role } : null}
      csrfToken={c.get('csrfToken') ?? ''}
      currentPath={c.req.path}
      flash={options.flash ?? takeFlash(c)}
      nonce={c.get('nonce') ?? ''}
      gridOverlay={options.gridOverlay}
    >
      {body}
    </Layout>
  );

  return c.html(`<!DOCTYPE html>${document.toString()}`, (options.status ?? 200) as 200);
}
