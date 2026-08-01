/**
 * Uploads held back for duplicate confirmation.
 *
 * When a new image fingerprints close to a map already in the library, the
 * upload cannot simply be re-rendered as a form: a browser will not re-populate
 * an `<input type="file">`, so asking the admin to look at the matches would
 * cost them the file they just chose. Instead the image is processed and written
 * exactly as a normal upload would be, and everything that would have gone into
 * the `maps` row is parked here until they confirm or discard.
 *
 * A row therefore means "the files exist on disk but no map does". Two things
 * clear one: the admin acting on it, or the maintenance sweep reclaiming it once
 * it has aged past `config.pendingUploadTtlSeconds`. Both delete the files too —
 * see `expiredPendingUploads`, whose caller is responsible for the unlinking.
 */
import { config, type ImageFormat } from '../config.ts';
import { db } from '../db/index.ts';
import type { GridSource } from '../images/grid.ts';

export interface PendingUpload {
  uuid: string;
  userId: string;
  /** The format the staged files were written in; the map row inherits it. */
  format: ImageFormat;
  fingerprint: string;
  gridSize: number | null;
  gridWidth: number | null;
  gridHeight: number | null;
  imageWidth: number;
  imageHeight: number;
  fileSize: number;
  gridSource: GridSource;
  upscaleFactor: number;
  originalFilename: string | null;
  createdAt: number;
}

interface PendingUploadRow {
  uuid: string;
  user_id: string;
  format: ImageFormat;
  fingerprint: string;
  grid_size: number | null;
  grid_width: number | null;
  grid_height: number | null;
  image_width: number;
  image_height: number;
  file_size: number;
  grid_source: GridSource;
  upscale_factor: number;
  original_filename: string | null;
  created_at: number;
}

const toPending = (row: PendingUploadRow): PendingUpload => ({
  uuid: row.uuid,
  userId: row.user_id,
  format: row.format,
  fingerprint: row.fingerprint,
  gridSize: row.grid_size,
  gridWidth: row.grid_width,
  gridHeight: row.grid_height,
  imageWidth: row.image_width,
  imageHeight: row.image_height,
  fileSize: row.file_size,
  gridSource: row.grid_source,
  upscaleFactor: row.upscale_factor,
  originalFilename: row.original_filename,
  createdAt: row.created_at,
});

export type PendingUploadInput = Omit<PendingUpload, 'createdAt'>;

export function createPendingUpload(input: PendingUploadInput): PendingUpload {
  db.query(
    `INSERT INTO pending_uploads (uuid, user_id, format, fingerprint, grid_size, grid_width, grid_height,
                                  image_width, image_height, file_size, grid_source, upscale_factor,
                                  original_filename, created_at)
     VALUES ($uuid, $userId, $format, $fingerprint, $gridSize, $gridWidth, $gridHeight,
             $imageWidth, $imageHeight, $fileSize, $gridSource, $upscaleFactor,
             $originalFilename, $createdAt)`,
  ).run({
    $uuid: input.uuid,
    $userId: input.userId,
    $format: input.format,
    $fingerprint: input.fingerprint,
    $gridSize: input.gridSize,
    $gridWidth: input.gridWidth,
    $gridHeight: input.gridHeight,
    $imageWidth: input.imageWidth,
    $imageHeight: input.imageHeight,
    $fileSize: input.fileSize,
    $gridSource: input.gridSource,
    $upscaleFactor: input.upscaleFactor,
    $originalFilename: input.originalFilename,
    $createdAt: Date.now(),
  });

  return findPendingUpload(input.uuid, input.userId)!;
}

/**
 * Looks up a staged upload the given user is entitled to act on.
 *
 * Scoped by `userId` and by age deliberately. The UUID travels back to the
 * browser in a hidden field, so it must not be a capability: another admin
 * replaying it gets nothing, and a form left open past the TTL is treated as
 * gone rather than resurrecting an upload whose files the sweep may already
 * have deleted.
 */
export function findPendingUpload(uuid: string, userId: string): PendingUpload | null {
  const cutoff = Date.now() - config.pendingUploadTtlSeconds * 1000;

  const row = db
    .query('SELECT * FROM pending_uploads WHERE uuid = ? AND user_id = ? AND created_at >= ?')
    .get(uuid, userId, cutoff) as PendingUploadRow | null;

  return row ? toPending(row) : null;
}

export function deletePendingUpload(uuid: string): void {
  db.query('DELETE FROM pending_uploads WHERE uuid = ?').run(uuid);
}

/**
 * Removes the rows that have aged out and reports their UUIDs.
 *
 * The files are left to the caller: this module knows nothing about storage, and
 * the sweep needs the list anyway to unlink them. Deleting the rows first means
 * a crash mid-sweep leaves orphaned files rather than rows pointing at files
 * that are already gone.
 */
export function expiredPendingUploads(ttlSeconds: number = config.pendingUploadTtlSeconds): string[] {
  const cutoff = Date.now() - ttlSeconds * 1000;

  const rows = db
    .query('DELETE FROM pending_uploads WHERE created_at < ? RETURNING uuid')
    .all(cutoff) as { uuid: string }[];

  return rows.map((row) => row.uuid);
}
