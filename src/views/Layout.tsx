/** The page shell: document head, header navigation, and flash messages. */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { raw } from 'hono/html';

import { CSRF_FIELD } from '../security/csrf.ts';
import type { Theme } from '../types.ts';
import type { Role } from '../models/users.ts';
import { assetUrl } from '../assets.ts';
import { config } from '../config.ts';
import { alert, button } from './ui.ts';

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
 * fixed-shape rule with no room for injected CSS. The colour rides along here
 * rather than as a utility class on the element, because it comes from
 * `GRID_OVERLAY_COLOR` and Tailwind can only compile classes it can see; it is
 * checked against a colour grammar at boot (`cssColor` in `config.ts`).
 */
function gridOverlayCss({ columns, rows }: { columns: number; rows: number }): string {
  const safeColumns = Math.min(Math.max(Math.round(columns), 1), 10_000);
  const safeRows = Math.min(Math.max(Math.round(rows), 1), 10_000);
  return (
    `.map-grid-overlay{background-size:${(100 / safeColumns).toFixed(4)}% ${(100 / safeRows).toFixed(4)}%;` +
    `--grid-overlay-color:${config.grid.overlayColor}}`
  );
}

const NavLink: FC<PropsWithChildren<{ href: string; active: boolean }>> = ({ href, active, children }) => (
  <li>
    <a href={href} aria-current={active ? 'page' : undefined} class={active ? 'menu-active' : undefined}>
      {children}
    </a>
  </li>
);

/**
 * Cycles system → light → dark → system.
 *
 * A plain form POST, so it works with JavaScript disabled; /app.js upgrades
 * it to an instant in-page toggle. The button is icon-only: the hover title
 * names the theme in effect, and the aria-label names that and the next one.
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
        class={`btn-square ${button.ghost}`}
        title={labels[current]}
        aria-label={`Current: ${labels[current].toLowerCase()}. Switch to ${labels[next].toLowerCase()}.`}
      >
        <span aria-hidden="true">{current === 'dark' ? '🌙' : current === 'light' ? '☀️' : '🖥️'}</span>
      </button>
    </form>
  );
};

const FlashBanner: FC<{ flash: Flash }> = ({ flash }) => (
  <div role={flash.kind === 'error' ? 'alert' : 'status'} class={`mb-6 ${alert[flash.kind]}`}>
    <span>{flash.message}</span>
  </div>
);

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
  // An explicit `data-theme` pins the theme; omitting it lets the stylesheet
  // fall back to the operating system preference, so there is no flash of the
  // wrong theme and no JavaScript is required to get the first paint right.
  <html lang="en" data-theme={theme === 'system' ? undefined : theme}>
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
    <body class="min-h-screen antialiased">
      <a
        href="#main"
        class="btn sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to content
      </a>

      <header class="bg-base-100 shadow-sm">
        <div class="navbar flex-wrap px-4 sm:px-6 lg:px-8">
          <div class="navbar-start w-auto gap-2">
            <a href={user ? '/maps' : '/login'} class="btn btn-ghost px-2 text-lg">
              <span aria-hidden="true">🗺️</span>
              {/* Only the emoji on a phone, so the menu fits beside it; the
                  name stays for screen readers either way. */}
              <span class="sr-only sm:not-sr-only">Battle Map Curator</span>
            </a>

            {user && (
              <nav aria-label="Main">
                <ul class="menu menu-horizontal gap-1 p-0">
                  <NavLink href="/maps" active={currentPath === '/maps'}>
                    Maps
                  </NavLink>
                  {user.role === 'admin' && (
                    <NavLink href="/maps/new" active={currentPath === '/maps/new'}>
                      Upload
                    </NavLink>
                  )}
                </ul>
              </nav>
            )}
          </div>

          <div class="navbar-end ml-auto w-auto gap-2">
            <ThemeToggle theme={theme} currentPath={currentPath} csrfToken={csrfToken} />
            {user && (
              <>
                <span class="hidden text-sm text-base-content/60 md:inline" title={user.email}>
                  {user.email}
                  {user.role === 'admin' && <span class="badge badge-xs badge-soft badge-primary ml-1">admin</span>}
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

      <main id="main" class="px-4 py-8 sm:px-6 lg:px-8">
        {flash && <FlashBanner flash={flash} />}
        {children}
      </main>
    </body>
  </html>
);
