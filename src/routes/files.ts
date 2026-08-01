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
import type { ImageFormat } from '../config.ts';
import { notFound } from '../errors.ts';
import { FORMAT_MIME_TYPES } from '../images/process.ts';
import { imageFile, isValidUuid, STORAGE_EXTENSIONS } from '../images/storage.ts';
import { findMap, type MapRecord } from '../models/maps.ts';
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
 * The row comes back rather than just the UUID because the row is what says
 * which format the files are in.
 */
function requireMap(uuid: string): MapRecord {
  if (!isValidUuid(uuid)) throw notFound('That map does not exist.');
  const map = findMap(uuid);
  if (!map) throw notFound('That map does not exist.');
  return map;
}

async function serve(
  c: Context<AppEnv>,
  uuid: string,
  variant: 'full' | 'thumb',
  format: ImageFormat,
  disposition?: string,
): Promise<Response> {
  const file = imageFile(uuid, variant, format);

  if (!(await file.exists())) {
    // The database row exists but the file does not — a real inconsistency
    // worth surfacing in the logs rather than a plain "not found".
    c.get('logger').error('image file missing on disk', { uuid, variant });
    throw notFound('That image file is missing. Please tell an administrator.');
  }

  const headers = new Headers({
    // From the row, not from IMAGE_FORMAT: a map keeps the format it was stored
    // in, so the two disagree for everything uploaded before a format change.
    'Content-Type': FORMAT_MIME_TYPES[format],
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

  return serve(c, uuid, 'thumb', pending.format);
});

fileRoutes.get('/i/:uuid/thumb', async (c) => {
  const map = requireMap(c.req.param('uuid'));
  return serve(c, map.uuid, 'thumb', map.format);
});

fileRoutes.get('/i/:uuid/full', async (c) => {
  const map = requireMap(c.req.param('uuid'));
  return serve(c, map.uuid, 'full', map.format);
});

fileRoutes.get('/i/:uuid/download', async (c) => {
  const map = requireMap(c.req.param('uuid'));

  c.get('logger').info('map downloaded', { uuid: map.uuid, name: map.name, format: map.format });

  return serve(c, map.uuid, 'full', map.format, `attachment; filename="${downloadFilename(map)}"`);
});

/**
 * Builds a tidy download filename from the map's name, variant and UUID.
 *
 * Every downloaded file has to land in the same folder without one overwriting
 * another, and neither the name nor the variant is enough on its own for that.
 * The pair is unique in the database, but the slug is not: "River Crossing"
 * with the variant "day" and a map plainly called "River Crossing Day" reduce to
 * the same thing, as do two names differing only in punctuation, two names
 * sharing their first 80 characters, and any two names with no ASCII letters in
 * them at all. So the map's own identifier goes on the end and settles it.
 *
 * Eight hex digits rather than the whole UUID: enough that a clash needs two
 * maps to agree on both the slug and the identifier, short enough to leave the
 * readable part readable. It is taken from the stored UUID rather than generated,
 * so downloading the same map twice gives the same filename and replaces the
 * earlier copy instead of piling up "(1)" duplicates beside it.
 *
 * Reduced to a conservative character set: the value lands in a
 * Content-Disposition header, where quotes or newlines would let it break out
 * of the header it sits in.
 */
export function downloadFilename(map: Pick<MapRecord, 'name' | 'variant' | 'uuid' | 'format'>): string {
  const base = [map.name, map.variant]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    // Truncation can land on a separator, which would double up below.
    .replace(/-+$/, '');

  return `${base || 'battle-map'}-${map.uuid.slice(0, 8)}${STORAGE_EXTENSIONS[map.format]}`;
}
