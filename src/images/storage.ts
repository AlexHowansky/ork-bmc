/**
 * On-disk image storage.
 *
 * Files live under IMAGE_DIR, which is deliberately outside `public/` and is
 * never mounted as a static directory — the only way to read one is through an
 * authenticated route.
 *
 * Paths are derived solely from a UUID that has been matched against
 * `UUID_V4_PATTERN`, so no request-controlled text ever reaches the filesystem
 * and directory traversal is structurally impossible rather than filtered.
 */
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { config, IMAGE_FORMATS, type ImageFormat } from '../config.ts';
import { log } from '../log.ts';

/**
 * What each format is called on disk.
 *
 * The extension is cosmetic — nothing globs the image directory and every route
 * states its own Content-Type — but a directory of files whose names disagree
 * with their contents is a trap for whoever next looks in there.
 */
export const STORAGE_EXTENSIONS: Record<ImageFormat, string> = {
  webp: '.webp',
  png: '.png',
  jpeg: '.jpg',
};

export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidUuid(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/** Throws if the value is not a UUID v4, so callers cannot forget to check. */
function assertUuid(uuid: string): void {
  if (!isValidUuid(uuid)) {
    throw new Error(`Refusing to build a storage path from a non-UUID value: ${JSON.stringify(uuid)}`);
  }
}

/**
 * Spreads files across 256 subdirectories keyed by the first two hex characters
 * of the UUID, so no single directory accumulates an unwieldy number of files.
 */
export function shardFor(uuid: string): string {
  assertUuid(uuid);
  return uuid.slice(0, 2);
}

export function shardDir(uuid: string): string {
  return join(config.imageDir, shardFor(uuid));
}

export function fullImagePath(uuid: string, format: ImageFormat): string {
  return join(shardDir(uuid), `${uuid}${STORAGE_EXTENSIONS[format]}`);
}

export function thumbImagePath(uuid: string, format: ImageFormat): string {
  return join(shardDir(uuid), `${uuid}_thumb${STORAGE_EXTENSIONS[format]}`);
}

export async function ensureImageDir(): Promise<void> {
  await mkdir(config.imageDir, { recursive: true });
  log.debug('image directory ready', { imageDir: config.imageDir });
}

/** Writes the full-resolution image and its thumbnail, creating the shard as needed. */
export async function storeImage(
  uuid: string,
  full: Uint8Array,
  thumb: Uint8Array,
  format: ImageFormat,
): Promise<void> {
  await mkdir(shardDir(uuid), { recursive: true });
  await Bun.write(fullImagePath(uuid, format), full);
  await Bun.write(thumbImagePath(uuid, format), thumb);
}

/**
 * Removes every file belonging to a map.
 *
 * Deliberately blind to the format: it sweeps all of them rather than taking the
 * one the row claims. A map is deleted precisely when its row is going away, and
 * a row that disagreed with the disk — because IMAGE_FORMAT changed under a
 * half-finished write, say — would otherwise leave a file behind with nothing
 * left to point at it. Missing files are not an error; the goal is that nothing
 * remains.
 */
export async function deleteImage(uuid: string): Promise<void> {
  const paths = IMAGE_FORMATS.flatMap((format) => [fullImagePath(uuid, format), thumbImagePath(uuid, format)]);

  for (const path of paths) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Worth knowing about — it means a file is orphaned on disk — but not
        // worth failing the user's delete over.
        log.error('could not delete image file', { path, error });
      }
    }
  }
}

export function imageFile(uuid: string, variant: 'full' | 'thumb', format: ImageFormat) {
  return Bun.file(variant === 'full' ? fullImagePath(uuid, format) : thumbImagePath(uuid, format));
}
