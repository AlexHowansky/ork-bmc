/**
 * Image delivery.
 *
 * These are the only routes that read from IMAGE_DIR, and every one of them is
 * behind `requireAuth` via the global middleware. There is no static mount of
 * the image directory anywhere, so an unauthenticated request cannot reach a
 * full-resolution map by any URL.
 */
import { Hono, type Context } from 'hono';

import { requireAdmin } from '../auth/middleware.ts';
import { notFound } from '../errors.ts';
import { imageFile, isValidUuid } from '../images/storage.ts';
import { findMap } from '../models/maps.ts';
import { findPendingUpload } from '../models/pendingUploads.ts';
import type { AppEnv } from '../types.ts';

export const fileRoutes = new Hono<AppEnv>();

// A staged upload has files but no map row, so it needs its own path. Four
// segments, so it cannot be confused with `/i/:uuid/thumb` below.
fileRoutes.use('/i/pending/*', requireAdmin());

/**
 * Resolves the `:uuid` route parameter to a map, or throws a 404.
 *
 * The UUID shape is checked before it is ever used to build a path, so a value
 * like `../../etc/passwd` is rejected here rather than being sanitised later.
 */
function requireMapUuid(uuid: string): string {
  if (!isValidUuid(uuid)) throw notFound('That map does not exist.');
  if (!findMap(uuid)) throw notFound('That map does not exist.');
  return uuid;
}

async function serve(
  c: Context<AppEnv>,
  uuid: string,
  variant: 'full' | 'thumb',
  disposition?: string,
): Promise<Response> {
  const file = imageFile(uuid, variant);

  if (!(await file.exists())) {
    // The database row exists but the file does not — a real inconsistency
    // worth surfacing in the logs rather than a plain "not found".
    c.get('logger').error('image file missing on disk', { uuid, variant });
    throw notFound('That image file is missing. Please tell an administrator.');
  }

  const headers = new Headers({
    'Content-Type': 'image/webp',
    // Stated explicitly rather than left to the runtime: later middleware
    // rebuilds the response to attach security headers, which would otherwise
    // turn this into a chunked transfer of unknown length and cost the browser
    // its download progress indicator.
    'Content-Length': String(file.size),
    // Private: these are authenticated responses and must not be held by a
    // shared cache where another user could be served them.
    'Cache-Control': 'private, max-age=3600',
  });
  if (disposition) headers.set('Content-Disposition', disposition);

  return new Response(file, { headers });
}

/**
 * The preview on the duplicate-confirmation page.
 *
 * Scoped to the admin who staged it, exactly as the confirmation itself is: the
 * UUID is in a form field on their screen, and that must not be enough for
 * anyone else to read an image the library has not accepted.
 */
fileRoutes.get('/i/pending/:uuid/thumb', async (c) => {
  const uuid = c.req.param('uuid');
  if (!isValidUuid(uuid)) throw notFound('That image is not waiting to be saved.');

  const pending = findPendingUpload(uuid, c.get('user')!.id);
  if (!pending) throw notFound('That image is not waiting to be saved.');

  return serve(c, uuid, 'thumb');
});

fileRoutes.get('/i/:uuid/thumb', async (c) => serve(c, requireMapUuid(c.req.param('uuid')), 'thumb'));

fileRoutes.get('/i/:uuid/full', async (c) => serve(c, requireMapUuid(c.req.param('uuid')), 'full'));

fileRoutes.get('/i/:uuid/download', async (c) => {
  const uuid = requireMapUuid(c.req.param('uuid'));
  const map = findMap(uuid)!;

  c.get('logger').info('map downloaded', { uuid, name: map.name });

  return serve(c, uuid, 'full', `attachment; filename="${downloadFilename(map.name, map.variant)}"`);
});

/**
 * Builds a tidy download filename from the map's name.
 *
 * Reduced to a conservative character set: the value lands in a
 * Content-Disposition header, where quotes or newlines would let it break out
 * of the header it sits in.
 */
export function downloadFilename(name: string, variant: string): string {
  const base = [name, variant]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${base || 'battle-map'}.webp`;
}
