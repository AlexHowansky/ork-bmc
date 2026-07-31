/** Sign in, sign out, and the theme preference toggle. */
import { Hono } from 'hono';
import { getConnInfo } from 'hono/bun';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { FC } from 'hono/jsx';

import { verifyPassword, wastePasswordVerifyTime } from '../auth/password.ts';
import { THEME_COOKIE } from '../auth/middleware.ts';
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  sessionCookieOptions,
} from '../auth/session.ts';
import { config } from '../config.ts';
import { findUserByEmail, normaliseEmail } from '../models/users.ts';
import { CsrfInput } from '../views/Layout.tsx';
import { clientIp, consumeToken, resetBucket } from '../security/ratelimit.ts';
import type { AppEnv } from '../types.ts';
import { page, setFlash } from '../views/render.tsx';
import { button, card, fieldError, input, inputInvalid, label } from '../views/ui.ts';

export const authRoutes = new Hono<AppEnv>();

/**
 * Only same-origin, absolute-path redirects are honoured after login, so a
 * crafted `?next=//evil.example` cannot bounce a freshly authenticated user
 * off-site.
 */
function safeNextPath(next: string | undefined): string {
  if (!next) return '/maps';
  // Must be a rooted path, and must not be protocol-relative. Some browsers
  // also treat a leading "/\" as protocol-relative, so reject that too.
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/maps';
  return next;
}

interface LoginPageProps {
  email: string;
  next: string;
  csrfToken: string;
  error?: string | undefined;
}

const LoginPage: FC<LoginPageProps> = ({ email, next, csrfToken, error }) => (
  <div class="mx-auto max-w-md">
    <div class={`p-6 sm:p-8 ${card}`}>
      <h1 class="text-2xl font-bold tracking-tight">Sign in</h1>
      <p class="mt-2 text-sm text-stone-600 dark:text-stone-400">
        Battle Mapper accounts are created by an administrator.
      </p>

      {error && (
        <div
          role="alert"
          class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
        >
          {error}
        </div>
      )}

      <form method="post" action="/login" class="mt-6 space-y-5">
        <CsrfInput token={csrfToken} />
        <input type="hidden" name="next" value={next} />

        <div>
          <label for="email" class={label}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            value={email}
            required
            autocomplete="username"
            autofocus
            class={`mt-1 ${error ? inputInvalid : input}`}
          />
        </div>

        <div>
          <label for="password" class={label}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autocomplete="current-password"
            class={`mt-1 ${error ? inputInvalid : input}`}
          />
          {error && <p class={fieldError}>Check your email and password and try again.</p>}
        </div>

        <button type="submit" class={`w-full ${button.primary}`}>
          Sign in
        </button>
      </form>
    </div>
  </div>
);

authRoutes.get('/login', (c) => {
  // Already signed in: no reason to show the form again.
  if (c.get('user')) return c.redirect(safeNextPath(c.req.query('next')), 302);

  return page(
    c,
    { title: 'Sign in' },
    <LoginPage email="" next={safeNextPath(c.req.query('next'))} csrfToken={c.get('csrfToken')} />,
  );
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const email = normaliseEmail(String(body['email'] ?? ''));
  const password = String(body['password'] ?? '');
  const next = safeNextPath(typeof body['next'] === 'string' ? body['next'] : undefined);
  const logger = c.get('logger');

  const ip = clientIp(c);

  // Two buckets: one per client, one per targeted account. A distributed
  // attack still cannot exceed the per-email budget.
  const allowed = consumeToken(`ip:${ip}`) && consumeToken(`email:${email}`);
  if (!allowed) {
    logger.warn('login rate limited', { email, ip });
    return page(
      c,
      { title: 'Sign in', status: 429 },
      <LoginPage
        email={email}
        next={next}
        csrfToken={c.get('csrfToken')}
        error="Too many sign-in attempts. Please wait a few minutes and try again."
      />,
    );
  }

  const user = findUserByEmail(email);

  // Same generic message and comparable timing whether the account exists or
  // the password is wrong — neither response should confirm an address.
  if (!user) {
    await wastePasswordVerifyTime(password);
    logger.warn('login failed: unknown account', { email, ip });
    return page(
      c,
      { title: 'Sign in', status: 401 },
      <LoginPage
        email={email}
        next={next}
        csrfToken={c.get('csrfToken')}
        error="That email and password combination is not correct."
      />,
    );
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    logger.warn('login failed: bad password', { email, ip, userId: user.id });
    return page(
      c,
      { title: 'Sign in', status: 401 },
      <LoginPage
        email={email}
        next={next}
        csrfToken={c.get('csrfToken')}
        error="That email and password combination is not correct."
      />,
    );
  }

  const { token } = createSession(user.id, { userAgent: c.req.header('user-agent'), ip });

  resetBucket(`ip:${ip}`);
  resetBucket(`email:${email}`);

  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions());
  logger.info('login succeeded', { userId: user.id, email: user.email, role: user.role, ip });

  return c.redirect(next, 302);
});

authRoutes.post('/logout', (c) => {
  const session = c.get('session');
  if (session) {
    // Server-side invalidation: clearing the cookie alone would leave a live
    // session that a copied cookie could still use.
    destroySession(session.id);
    c.get('logger').info('logout', { userId: session.userId });
  }

  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: config.cookieSecure });
  setFlash(c, { kind: 'info', message: 'You have been signed out.' });

  return c.redirect('/login', 302);
});

/**
 * Theme preference.
 *
 * Reachable while signed out, which is why anonymous visitors are still issued
 * a CSRF token — see `anonymousCsrfToken` in auth/middleware.ts.
 */
authRoutes.post('/theme', async (c) => {
  const body = await c.req.parseBody();
  const requested = String(body['theme'] ?? 'system');
  const theme = ['light', 'dark', 'system'].includes(requested) ? requested : 'system';

  if (theme === 'system') {
    deleteCookie(c, THEME_COOKIE, { path: '/' });
  } else {
    setCookie(c, THEME_COOKIE, theme, {
      path: '/',
      httpOnly: false, // /app.js reads this to toggle without a round trip.
      secure: config.cookieSecure,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return c.redirect(safeNextPath(typeof body['next'] === 'string' ? body['next'] : undefined), 302);
});
