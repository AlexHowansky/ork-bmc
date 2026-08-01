/**
 * Cache stamps for the two built assets.
 *
 * `/app.css` and `/app.js` are served from fixed URLs, so a browser that has
 * cached one keeps running it until the header expires — which means an edited
 * script or a rebuilt stylesheet can appear to have had no effect at all, on the
 * one machine that matters most: the developer's. Appending the file's
 * modification time to the URL makes a changed file a different URL, so it is
 * fetched at once and an unchanged one is not fetched again.
 *
 * The stamp is read per render. That is a stat, not a read, and this app serves
 * a handful of users; being right about what the browser is running is worth far
 * more than the syscall.
 */
import { join } from 'node:path';

export const PUBLIC_DIR = join(import.meta.dir, '..', 'public');

export type Asset = 'app.css' | 'app.js';

export function assetVersion(name: Asset): string {
  const modified = Bun.file(join(PUBLIC_DIR, name)).lastModified;

  // A missing file has no useful stamp; the asset route reports that properly.
  return Number.isFinite(modified) && modified > 0 ? Math.floor(modified).toString(36) : 'dev';
}

/** The URL to link an asset by, stamped so a stale copy cannot be served. */
export function assetUrl(name: Asset): string {
  return `/${name}?v=${assetVersion(name)}`;
}
