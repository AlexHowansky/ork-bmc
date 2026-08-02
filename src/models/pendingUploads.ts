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
import { hashToken, randomToken } from '../auth/session.ts';
import { config, type ImageFormat } from '../config.ts';
import { db } from '../db/index.ts';
import type { GridInput, GridSource } from '../images/grid.ts';

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
  /**
   * What the admin actually typed, as opposed to what `resolveGrid` made of it.
   * Kept because adopting a higher-resolution copy has to resolve the grid again
   * against different dimensions, and "70 pixel squares" and "30 squares across"
   * are not the same claim about a bigger image even when they agree about this
   * one. The resolved columns above cannot tell the two apart.
   */
  inputGrid: GridInput;
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
  input_grid_size: number | null;
  input_grid_width: number | null;
  input_grid_height: number | null;
  created_at: number;
}

/** SQLite has no undefined, and `GridInput` has no null. */
const optional = (value: number | null): number | undefined => value ?? undefined;

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
  inputGrid: {
    gridSize: optional(row.input_grid_size),
    gridWidth: optional(row.input_grid_width),
    gridHeight: optional(row.input_grid_height),
  },
  createdAt: row.created_at,
});

export type PendingUploadInput = Omit<PendingUpload, 'createdAt'>;

export function createPendingUpload(input: PendingUploadInput): PendingUpload {
  db.query(
    `INSERT INTO pending_uploads (uuid, user_id, format, fingerprint, grid_size, grid_width, grid_height,
                                  image_width, image_height, file_size, grid_source, upscale_factor,
                                  original_filename, input_grid_size, input_grid_width, input_grid_height,
                                  created_at)
     VALUES ($uuid, $userId, $format, $fingerprint, $gridSize, $gridWidth, $gridHeight,
             $imageWidth, $imageHeight, $fileSize, $gridSource, $upscaleFactor,
             $originalFilename, $inputGridSize, $inputGridWidth, $inputGridHeight,
             $createdAt)`,
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
    $inputGridSize: input.inputGrid.gridSize ?? null,
    $inputGridWidth: input.inputGrid.gridWidth ?? null,
    $inputGridHeight: input.inputGrid.gridHeight ?? null,
    $createdAt: Date.now(),
  });

  return findPendingUpload(input.uuid, input.userId)!;
}

/**
 * Records the image an adopted candidate replaced the staged one with.
 *
 * Everything measured from the pixels changes at once, because they are all
 * readings of the same new file. `upscaleFactor` is replaced rather than
 * multiplied: the edit path accumulates because it resamples its own output,
 * but this starts again from a source the library has never seen, so whatever
 * the admin's original upload needed no longer describes anything.
 */
export function updatePendingImage(
  uuid: string,
  image: Pick<
    PendingUpload,
    | 'imageWidth'
    | 'imageHeight'
    | 'fileSize'
    | 'fingerprint'
    | 'format'
    | 'gridSize'
    | 'gridWidth'
    | 'gridHeight'
    | 'gridSource'
    | 'upscaleFactor'
  >,
): void {
  db.query(
    `UPDATE pending_uploads
        SET image_width = $imageWidth, image_height = $imageHeight, file_size = $fileSize,
            fingerprint = $fingerprint, format = $format, grid_size = $gridSize,
            grid_width = $gridWidth, grid_height = $gridHeight, grid_source = $gridSource,
            upscale_factor = $upscaleFactor
      WHERE uuid = $uuid`,
  ).run({
    $uuid: uuid,
    $imageWidth: image.imageWidth,
    $imageHeight: image.imageHeight,
    $fileSize: image.fileSize,
    $fingerprint: image.fingerprint,
    $format: image.format,
    $gridSize: image.gridSize,
    $gridWidth: image.gridWidth,
    $gridHeight: image.gridHeight,
    $gridSource: image.gridSource,
    $upscaleFactor: image.upscaleFactor,
  });
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
 * Issues the bearer token a search provider needs to read a staged image.
 *
 * The provider fetches the image itself and has no session, so for the length of
 * one search this file is readable by whoever holds the token. Only its SHA-256
 * is kept, exactly as a session's is, and the returned plaintext is never stored
 * or logged — it exists only long enough to be put in a URL.
 *
 * Deliberately short-lived and deliberately narrow: one unsaved image, minutes,
 * and revoked the moment the search that needed it comes back.
 */
export function mintShareToken(uuid: string, ttlSeconds: number = config.webSearch.shareTtlSeconds): string {
  const token = randomToken();

  db.query('UPDATE pending_uploads SET share_token = ?, share_token_expires_at = ? WHERE uuid = ?').run(
    hashToken(token),
    Date.now() + ttlSeconds * 1000,
    uuid,
  );

  return token;
}

export function clearShareToken(uuid: string): void {
  db.query('UPDATE pending_uploads SET share_token = NULL, share_token_expires_at = NULL WHERE uuid = ?').run(
    uuid,
  );
}

/**
 * Resolves a share token to the upload it was issued for.
 *
 * Looked up by hash rather than compared, so there is no timing signal and the
 * stored value is useless to anyone who reads the database. Expiry is part of
 * the query for the same reason `findPendingUpload` scopes by age: a stale token
 * should be indistinguishable from one that never existed.
 */
export function findPendingByShareToken(token: string): PendingUpload | null {
  const row = db
    .query('SELECT * FROM pending_uploads WHERE share_token = ? AND share_token_expires_at > ?')
    .get(hashToken(token), Date.now()) as PendingUploadRow | null;

  return row ? toPending(row) : null;
}

/**
 * Revokes tokens that outlived their search.
 *
 * The happy path clears a token as soon as the provider answers; this is for the
 * process that died between minting one and using it. Run by the maintenance
 * sweep, so an interrupted search cannot leave an image readable for the whole
 * hour its staged row survives.
 */
export function expireShareTokens(): number {
  const rows = db
    .query(
      `UPDATE pending_uploads
          SET share_token = NULL, share_token_expires_at = NULL
        WHERE share_token IS NOT NULL AND share_token_expires_at <= ?
    RETURNING uuid`,
    )
    .all(Date.now()) as { uuid: string }[];

  return rows.length;
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
