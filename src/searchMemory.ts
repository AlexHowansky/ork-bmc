/**
 * The last search a user ran, remembered until they clear it or sign out.
 *
 * Browsing a library is a loop: search, open a map, come back, open another.
 * Losing the filters on every return trip makes that loop tedious, so the four
 * fields the search form owns are kept in a cookie and re-applied when the
 * listing is opened with no query of its own.
 *
 * A cookie rather than a column on the session: this is a browser's idea of
 * where it was, it needs no migration, and it disappears with the session it was
 * set alongside. Its contents are ordinary untrusted input — the value is parsed
 * back through the same validation the query string gets, and the listing route
 * rebuilds the query from validated values rather than passing the cookie on, so
 * nothing a user can write into it survives as anything but a valid search.
 */
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';

import { config } from './config.ts';
import type { AppEnv } from './types.ts';

export const SEARCH_COOKIE = 'bmc_search';

/** The parameters the search form owns; `page` is deliberately not among them. */
export const SEARCH_PARAMS = ['q', 'tags', 'mode', 'sort'] as const;

/**
 * Long enough for the longest search the listing will accept (200 characters of
 * text, 500 of tags, both percent-encoded) and nowhere near a browser's limit.
 */
const MAX_COOKIE_LENGTH = 3000;

/** True when the request carries a search of its own, however empty. */
export function carriesSearch(c: Context<AppEnv>): boolean {
  return SEARCH_PARAMS.some((name) => c.req.query(name) !== undefined);
}

/**
 * The remembered query string, or '' when there is nothing to restore.
 *
 * Returned as raw text for the caller to re-parse; it has been no further
 * validated than its length, because the caller validates every field anyway.
 */
export function rememberedSearch(c: Context<AppEnv>): string {
  const stored = getCookie(c, SEARCH_COOKIE) ?? '';
  return stored.length > MAX_COOKIE_LENGTH ? '' : stored;
}

/**
 * Stores a search, or forgets the last one when this search has no filters.
 *
 * Takes the canonical query the listing built from its validated values, so what
 * comes back is what the listing would have produced anyway.
 */
export function rememberSearch(c: Context<AppEnv>, query: string): void {
  if (query === '') {
    // Only worth a Set-Cookie if there is something to clear; the unfiltered
    // listing is the common page and needs no header of its own.
    if (getCookie(c, SEARCH_COOKIE) !== undefined) forgetSearch(c);
    return;
  }

  setCookie(c, SEARCH_COOKIE, query, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    // Matched to the session it belongs to: a search cannot usefully outlive
    // the login that ran it, and signing out clears it outright.
    maxAge: config.sessionTtlSeconds,
  });
}

export function forgetSearch(c: Context<AppEnv>): void {
  deleteCookie(c, SEARCH_COOKIE, { path: '/', secure: config.cookieSecure });
}
