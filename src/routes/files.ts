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
import { notFound, tooManyRequests } from '../errors.ts';
import { FORMAT_MIME_TYPES } from '../images/process.ts';
import { imageFile, isValidUuid, STORAGE_EXTENSIONS } from '../images/storage.ts';
import { findMap, type MapRecord } from '../models/maps.ts';
import { findPendingByShareToken, findPendingUpload } from '../models/pendingUploads.ts';
import { findCandidate } from '../models/uploadCandidates.ts';
import { clientIp, consumeToken } from '../security/ratelimit.ts';
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
  overrides?: Record<string, string>,
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
  for (const [name, value] of Object.entries(overrides ?? {})) headers.set(name, value);

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

/**
 * A candidate's preview, stored as bytes rather than as a file.
 *
 * The content security policy allows images from this origin only, so a
 * thumbnail found on the web has to be served back out by this app. Scoped like
 * the preview above: the staged upload must belong to the admin asking, and the
 * candidate must belong to that upload.
 */
fileRoutes.get('/i/pending/:uuid/candidate/:id', async (c) => {
  const uuid = c.req.param('uuid');
  if (!isValidUuid(uuid)) throw notFound('That image is not waiting to be saved.');

  const pending = findPendingUpload(uuid, c.get('user')!.id);
  if (!pending) throw notFound('That image is not waiting to be saved.');

  const id = Number(c.req.param('id'));
  const candidate = Number.isInteger(id) ? findCandidate(id, uuid) : null;

  if (!candidate?.thumb || !candidate.thumbFormat) throw notFound('That preview is not available.');

  // A Blob rather than the array itself: the bytes come back from SQLite as a
  // view onto its own buffer, and wrapping them hands the response something
  // with a definite length and no borrowed memory behind it.
  return new Response(new Blob([candidate.thumb]), {
    headers: new Headers({
      'Content-Type': FORMAT_MIME_TYPES[candidate.thumbFormat],
      'Content-Length': String(candidate.thumb.byteLength),
      'Cache-Control': 'private, max-age=3600',
    }),
  });
});

/**
 * The staged image, for a search provider that has no session and never will.
 *
 * This is the one route in the app that can serve a full-resolution image to
 * something that has not signed in, and it exists because reverse image search
 * works by handing the provider an address to fetch. Its blast radius is kept
 * to what that requires and no more: one upload that is not yet a map, held by
 * a 256-bit token that is stored only as a hash, valid for minutes, revoked the
 * moment the search it was minted for comes back, and never issued at all if the
 * admin unticked the box on the upload form.
 *
 * A fixed path with the token in the query, not `/p/:token`, because
 * `PUBLIC_PATHS` matches a path exactly — a parameterised public route would
 * mean loosening deny-by-default for every route in the app to serve this one.
 * `c.req.path` excludes the query string, so the token stays out of the logs.
 */
fileRoutes.get('/staged-image', async (c) => {
  // The only unauthenticated reader of IMAGE_DIR, so it is also the only one
  // that can be probed. A token is unguessable, but nothing is served for free.
  if (!consumeToken(`staged-image:${clientIp(c)}`, { capacity: 120, windowSeconds: 300 })) {
    throw tooManyRequests();
  }

  const token = c.req.query('t') ?? '';
  const pending = token === '' ? null : findPendingByShareToken(token);

  if (!pending) throw notFound('That image is not available.');

  return serve(c, pending.uuid, 'full', pending.format, undefined, {
    // Never held anywhere: the address stops working within minutes and the
    // image behind it is not public in any other sense.
    'Cache-Control': 'no-store',
  });
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
