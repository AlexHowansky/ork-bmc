/**
 * Public static assets.
 *
 * Only these three files are served without authentication, and each is served
 * by explicit route rather than by mounting a directory — there is no path
 * segment a request can influence, so no traversal surface.
 */
import { Hono } from 'hono';
import { join } from 'node:path';

import { PUBLIC_DIR } from '../assets.ts';
import { notFound } from '../errors.ts';
import type { AppEnv } from '../types.ts';

export const staticRoutes = new Hono<AppEnv>();

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#d97706"/>
<g stroke="#fff" stroke-width="1.6" opacity=".9">
<path d="M4 12h24M4 20h24M12 4v24M20 4v24"/>
</g></svg>`;

staticRoutes.get('/app.css', async (c) => {
  const file = Bun.file(join(PUBLIC_DIR, 'app.css'));
  if (!(await file.exists())) {
    // A missing stylesheet means the build step was skipped; say so plainly
    // rather than serving a blank page with no explanation.
    c.get('logger').error('stylesheet missing — run `bun run css:build`');
    throw notFound('The stylesheet has not been built yet. Run `bun run css:build`.');
  }

  c.header('Content-Type', 'text/css; charset=utf-8');
  // Held for a day because the URL carries the file's stamp (see src/assets.ts):
  // a rebuilt stylesheet is a different URL and is fetched immediately.
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(await file.arrayBuffer());
});

staticRoutes.get('/app.js', async (c) => {
  const file = Bun.file(join(PUBLIC_DIR, 'app.js'));
  c.header('Content-Type', 'text/javascript; charset=utf-8');
  // Same bargain as the stylesheet: long-lived, but only for this exact version.
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(await file.arrayBuffer());
});

staticRoutes.get('/favicon.svg', (c) => {
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(FAVICON);
});
