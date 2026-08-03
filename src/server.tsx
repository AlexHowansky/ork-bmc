/**
 * Application entry point.
 *
 * Middleware order matters and is deliberate:
 *   1. request context   — every later layer logs with a request id
 *   2. security headers  — applied even to error responses
 *   3. session           — populates user/theme/csrfToken; must precede any
 *                          layer that can throw, because the error page is
 *                          rendered with this same context
 *   4. body limit        — reject oversized uploads before parsing them
 *   5. origin CSRF       — cheap header check, no body read
 *   6. token CSRF        — needs the session from step 3
 *   7. requireAuth       — deny-by-default for everything not public
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf as originCsrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';

import { attachSession, requestContext, requireAuth } from './auth/middleware.ts';
import { purgeExpiredSessions } from './auth/session.ts';
import { config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { AppError, isAppError, payloadTooLarge } from './errors.ts';
import { deleteImage, ensureImageDir } from './images/storage.ts';
import { log } from './log.ts';
import { expiredPendingUploads, expireShareTokens } from './models/pendingUploads.ts';
import { adminRoutes } from './routes/admin.tsx';
import { authRoutes } from './routes/auth.tsx';
import { fileRoutes } from './routes/files.ts';
import { mapRoutes } from './routes/maps.tsx';
import { staticRoutes } from './routes/static.ts';
import { csrfToken } from './security/csrf.ts';
import { securityHeaders } from './security/headers.ts';
import { purgeStaleBuckets } from './security/ratelimit.ts';
import type { AppEnv } from './types.ts';
import { ErrorPage } from './views/ErrorPage.tsx';
import { page } from './views/render.tsx';

export const app = new Hono<AppEnv>();

app.use('*', requestContext());
app.use('*', securityHeaders());
app.use('*', attachSession());

// Sized to the largest permitted image plus room for the surrounding form
// fields. The upload handler re-checks the image itself for a precise message.
app.use(
  '*',
  bodyLimit({
    maxSize: config.maxUploadBytes + 1024 * 1024,
    onError: () => {
      throw payloadTooLarge(
        `That upload is too large. The maximum size is ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB.`,
      );
    },
  }),
);

app.use('*', originCsrf());
app.use('*', csrfToken());
app.use('*', requireAuth());

app.route('/', staticRoutes);
app.route('/', authRoutes);
// Admin routes are mounted before the browse routes: `/maps/new` is a literal
// path that would otherwise be swallowed by `/maps/:uuid` and reported as a
// missing map.
app.route('/', adminRoutes);
app.route('/', mapRoutes);
app.route('/', fileRoutes);

app.get('/healthz', (c) => c.json({ status: 'ok' }));

app.get('/', (c) => c.redirect('/maps', 302));

app.notFound((c) =>
  page(
    c,
    { title: 'Not found', status: 404 },
    <ErrorPage status={404} message="That page does not exist." requestId={c.get('requestId')} />,
  ),
);

/**
 * Normalises anything thrown into an AppError.
 *
 * Hono's own middleware (the origin CSRF check, the body limit) throws
 * `HTTPException` with a meaningful status; keep it rather than flattening a
 * deliberate 403 into a confusing 500. Its message is framework text, so it is
 * replaced with wording aimed at a person.
 */
function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof HTTPException) {
    const messages: Record<number, string> = {
      403: 'That request was blocked for security reasons. Please reload the page and try again.',
      413: `That upload is too large. The maximum size is ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB.`,
    };
    return new AppError(messages[error.status] ?? 'That request could not be completed.', {
      status: error.status,
      code: 'http_exception',
      cause: error,
    });
  }

  return new AppError('Something went wrong on our end. Please try again.', { cause: error });
}

app.onError((error, c) => {
  const logger = c.get('logger') ?? log;
  const appError = toAppError(error);

  // Unexpected failures are logged in full; expected ones (a 404, a rejected
  // form) are routine and only worth a warning.
  if (appError.status >= 500) {
    logger.error('request failed', { status: appError.status, code: appError.code, error });
  } else {
    logger.warn('request rejected', { status: appError.status, code: appError.code, message: appError.userMessage });
  }

  if (appError.status === 401 && c.req.method === 'GET') {
    return c.redirect('/login', 302);
  }

  return page(
    c,
    { title: 'Error', status: appError.status },
    <ErrorPage status={appError.status} message={appError.userMessage} requestId={c.get('requestId') ?? 'unknown'} />,
  );
});

/** Periodic cleanup of rows that have aged out. */
function startMaintenance(): void {
  const runSweep = async () => {
    try {
      const sessions = purgeExpiredSessions();
      const buckets = purgeStaleBuckets();

      // An upload staged for duplicate confirmation and then abandoned owns two
      // files that nothing else will ever reclaim, so the row and the files go
      // together. Rows first: an orphaned file is a smaller problem than a row
      // pointing at a file that is already gone.
      const staged = expiredPendingUploads();
      for (const uuid of staged) {
        await deleteImage(uuid);
      }

      // Tidying rather than enforcement: a share token stops working the moment
      // it expires, because the lookup checks the expiry itself. This clears the
      // stored hashes left behind when a search never came back to revoke its
      // own — a process that died mid-search, most likely.
      const tokens = expireShareTokens();

      if (sessions > 0 || buckets > 0 || staged.length > 0 || tokens > 0) {
        log.debug('maintenance sweep', {
          expiredSessions: sessions,
          staleRateLimitBuckets: buckets,
          abandonedUploads: staged.length,
          expiredShareTokens: tokens,
        });
      }
    } catch (error) {
      log.error('maintenance sweep failed', { error });
    }
  };

  void runSweep();
  // `unref` so this timer never keeps the process alive on shutdown.
  setInterval(() => void runSweep(), 60 * 60 * 1000).unref();
}

if (import.meta.main) {
  await migrate();
  await ensureImageDir();
  startMaintenance();

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch: app.fetch,
    maxRequestBodySize: config.maxUploadBytes + 2 * 1024 * 1024,
  });

  log.info('battle map curator started', {
    url: `http://${config.host}:${config.port}`,
    env: config.env,
    imageDir: config.imageDir,
    cookieSecure: config.cookieSecure,
  });

  if (!config.cookieSecure) {
    log.warn('COOKIE_SECURE is disabled — session cookies will be sent over plain HTTP. Do not use this in production.');
  }

  const shutdown = () => {
    log.info('shutting down');
    void server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
