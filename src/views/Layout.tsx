/** The page shell: document head, header navigation, and flash messages. */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';

import { CSRF_FIELD } from '../security/csrf.ts';
import type { Theme } from '../types.ts';
import type { Role } from '../models/users.ts';
import { assetUrl } from '../assets.ts';
import { button } from './ui.ts';

export interface Flash {
  kind: 'success' | 'error' | 'info';
  message: string;
}

export interface LayoutProps {
  title: string;
  theme: Theme;
  /** Null on the login page, which renders without navigation. */
  user: { email: string; role: Role } | null;
  csrfToken: string;
  currentPath: string;
  flash?: Flash | undefined;
  /** CSP nonce authorising the optional grid-overlay style block below. */
  nonce: string;
  /**
   * Square counts for the map detail page's grid overlay. Passed as numbers
   * rather than CSS text so there is no string for a caller to inject into.
   */
  gridOverlay?: { columns: number; rows: number } | undefined;
}

/** Hidden field carrying the per-session synchroniser token. */
export const CsrfInput: FC<{ token: string }> = ({ token }) => (
  <input type="hidden" name={CSRF_FIELD} value={token} />
);

/**
 * Builds the one dynamic rule the app needs.
 *
 * Sizing the overlay in percentages rather than pixels means it lines up at
 * whatever width the image is actually displayed, on a phone or a desktop.
 * Both inputs are clamped to positive integers, so the result is always a
 * fixed-shape rule with no room for injected CSS.
 */
function gridOverlayCss({ columns, rows }: { columns: number; rows: number }): string {
  const safeColumns = Math.min(Math.max(Math.round(columns), 1), 10_000);
  const safeRows = Math.min(Math.max(Math.round(rows), 1), 10_000);
  return `.map-grid-overlay{background-size:${(100 / safeColumns).toFixed(4)}% ${(100 / safeRows).toFixed(4)}%}`;
}

const NavLink: FC<PropsWithChildren<{ href: string; active: boolean }>> = ({ href, active, children }) => (
  <a
    href={href}
    aria-current={active ? 'page' : undefined}
    class={
      'rounded-lg px-3 py-2 text-sm font-medium transition ' +
      (active
        ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300'
        : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100')
    }
  >
    {children}
  </a>
);

/**
 * Cycles system → light → dark → system.
 *
 * A plain form POST, so it works with JavaScript disabled; /app.js upgrades
 * it to an instant in-page toggle. The button labels the theme it switches to.
 */
const ThemeToggle: FC<{ theme: Theme; currentPath: string; csrfToken: string }> = ({
  theme,
  currentPath,
  csrfToken,
}) => {
  const labels: Record<Theme, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };
  // Tolerate an unexpected value rather than throwing while rendering a page
  // that may itself be an error page.
  const current: Theme = theme in labels ? theme : 'system';
  const next: Theme = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';

  return (
    <form method="post" action="/theme" data-theme-toggle>
      <CsrfInput token={csrfToken} />
      <input type="hidden" name="theme" value={next} />
      <input type="hidden" name="next" value={currentPath} />
      <button
        type="submit"
        class={button.ghost}
        title={`Switch to ${labels[next].toLowerCase()}`}
        aria-label={`Current: ${labels[current].toLowerCase()}. Switch to ${labels[next].toLowerCase()}.`}
      >
        <span aria-hidden="true">{current === 'dark' ? '🌙' : current === 'light' ? '☀️' : '🖥️'}</span>
        <span class="hidden sm:inline">{labels[current]}</span>
      </button>
    </form>
  );
};

const FlashBanner: FC<{ flash: Flash }> = ({ flash }) => {
  const styles: Record<Flash['kind'], string> = {
    success:
      'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
    error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200',
    info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-200',
  };

  return (
    <div
      role={flash.kind === 'error' ? 'alert' : 'status'}
      class={`mb-6 rounded-lg border px-4 py-3 text-sm ${styles[flash.kind]}`}
    >
      {flash.message}
    </div>
  );
};

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  theme,
  user,
  csrfToken,
  currentPath,
  flash,
  nonce,
  gridOverlay,
  children,
}) => (
  // An explicit class pins the theme; omitting it lets the stylesheet fall back
  // to the operating system preference, so there is no flash of the wrong theme
  // and no JavaScript is required to get the first paint right.
  <html lang="en" class={theme === 'system' ? undefined : theme}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>{title} · Battle Map Curator</title>
      <link rel="stylesheet" href={assetUrl('app.css')} />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <script src={assetUrl('app.js')} defer></script>
      {gridOverlay && <style nonce={nonce}>{raw(gridOverlayCss(gridOverlay))}</style>}
    </head>
    <body class="min-h-screen bg-stone-50 text-stone-900 antialiased dark:bg-stone-950 dark:text-stone-100">
      <a
        href="#main"
        class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow dark:focus:bg-stone-800"
      >
        Skip to content
      </a>

      <header class="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <a href={user ? '/maps' : '/login'} class="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span aria-hidden="true">🗺️</span>
            <span>Battle Map Curator</span>
          </a>

          {user && (
            <nav class="flex items-center gap-1" aria-label="Main">
              <NavLink href="/maps" active={currentPath === '/maps'}>
                Maps
              </NavLink>
              {user.role === 'admin' && (
                <NavLink href="/maps/new" active={currentPath === '/maps/new'}>
                  Upload
                </NavLink>
              )}
            </nav>
          )}

          <div class="ml-auto flex items-center gap-2">
            <ThemeToggle theme={theme} currentPath={currentPath} csrfToken={csrfToken} />
            {user && (
              <>
                <span class="hidden text-sm text-stone-500 md:inline dark:text-stone-400" title={user.email}>
                  {user.email}
                  {user.role === 'admin' && (
                    <span class="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      admin
                    </span>
                  )}
                </span>
                <form method="post" action="/logout">
                  <CsrfInput token={csrfToken} />
                  <button type="submit" class={button.ghost}>
                    Sign out
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main" class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {flash && <FlashBanner flash={flash} />}
        {children}
      </main>
    </body>
  </html>
);
