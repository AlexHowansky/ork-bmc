/**
 * Upload processing: validate, normalise, convert to WEBP, thumbnail.
 *
 * Stored maps are always **lossless** WEBP, so converting a PNG or JPEG never
 * costs quality. Thumbnails are a separate derived preview and are lossy by
 * design — a lossless thumbnail would be pointlessly large.
 */
import sharp from 'sharp';

import { config } from '../config.ts';
import { badRequest, payloadTooLarge } from '../errors.ts';
import { log } from '../log.ts';
import { fingerprintImage } from './fingerprint.ts';
import {
  fitGridToCounts,
  resolveGrid,
  solveIntegerUpscale,
  type GridInput,
  type ResolvedGrid,
  type TargetSize,
} from './grid.ts';
import { imageFile, storeImage } from './storage.ts';

export const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

/** WEBP cannot represent a dimension beyond this, whatever the source format. */
const WEBP_MAX_DIMENSION = 16_383;

export type DetectedFormat = 'png' | 'jpeg' | 'webp';

/**
 * Identifies the format from the file's own leading bytes.
 *
 * The browser-supplied Content-Type and the filename extension are both
 * attacker-controlled, so neither is trusted for this decision.
 */
export function sniffFormat(bytes: Uint8Array): DetectedFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export interface ProcessedImage {
  uuid: string;
  imageWidth: number;
  imageHeight: number;
  fileSize: number;
  grid: ResolvedGrid;
  /** Taken from the stored pixels, for recognising a map already in the library. */
  fingerprint: string;
}

export interface ProcessOptions {
  /** Grid values the admin typed in, if any. */
  grid: GridInput;
  /** Reuse an existing UUID (used when replacing the image on an existing map). */
  uuid?: string;
}

/**
 * Runs an uploaded file through the whole pipeline and writes it to disk.
 * Throws `AppError` with a user-facing message for anything the admin can fix.
 */
export async function processUpload(bytes: Uint8Array, options: ProcessOptions): Promise<ProcessedImage> {
  if (bytes.length === 0) {
    throw badRequest('That file is empty. Please choose an image.');
  }
  if (bytes.length > config.maxUploadBytes) {
    throw payloadTooLarge(
      `That image is ${formatMb(bytes.length)}, over the ${formatMb(config.maxUploadBytes)} limit.`,
    );
  }

  const format = sniffFormat(bytes);
  if (!format) {
    throw badRequest('That file is not a PNG, JPG, or WEBP image. Please choose a different file.');
  }

  // `limitInputPixels` makes sharp refuse a decompression bomb rather than
  // trying to allocate it.
  const pipeline = sharp(bytes, { limitInputPixels: config.maxImagePixels, failOn: 'error' });

  let metadata;
  try {
    metadata = await pipeline.metadata();
  } catch (error) {
    log.warn('could not read image metadata', { error });
    throw badRequest('That image could not be read. It may be corrupt or in an unsupported variant of the format.');
  }

  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  if (!sourceWidth || !sourceHeight) {
    throw badRequest('That image has no readable dimensions. It may be corrupt.');
  }

  if (sourceWidth * sourceHeight > config.maxImagePixels) {
    throw payloadTooLarge('That image has too many pixels to process. Please scale it down and try again.');
  }

  const uuid = options.uuid ?? crypto.randomUUID();

  // Decide the grid before encoding, because a fractional grid size — whether
  // counted by the admin or detected — calls for an upscale that changes the
  // dimensions written to disk.
  const grid = resolveGrid(options.grid, { width: sourceWidth, height: sourceHeight });

  const outputWidth = grid.target?.width ?? sourceWidth;
  const outputHeight = grid.target?.height ?? sourceHeight;

  assertWebpEncodable(outputWidth, outputHeight);

  // `.rotate()` with no argument applies the EXIF orientation, so a photo of a
  // battle map is stored the way it was taken. Re-encoding also drops every
  // other metadata block, including anything malicious hidden in one.
  let output = sharp(bytes, { limitInputPixels: config.maxImagePixels }).rotate();

  if (grid.target) {
    output = output.resize({ width: outputWidth, height: outputHeight, kernel: 'lanczos3', fit: 'fill' });
  }

  const full = await output.webp({ lossless: true, effort: 4 }).toBuffer();
  const thumb = await makeThumbnail(full);

  // Taken from the encoded output rather than the source bytes, so the stored
  // fingerprint always describes the file that is actually on disk — including
  // any enlargement the grid called for. The hash is computed from a 32×32
  // reduction, so that enlargement makes almost no difference to it.
  const fingerprint = await fingerprintImage(full);

  await storeImage(uuid, full, thumb);

  // Rotation can transpose the dimensions, so read them back from the encoded
  // output rather than assuming what went in.
  const finalMeta = await sharp(full).metadata();
  const imageWidth = finalMeta.width ?? outputWidth;
  const imageHeight = finalMeta.height ?? outputHeight;

  log.info('image processed', {
    uuid,
    sourceFormat: format,
    sourceBytes: bytes.length,
    storedBytes: full.length,
    imageWidth,
    imageHeight,
    upscaleFactor: grid.upscaleFactor,
    gridSource: grid.source,
    fingerprint,
  });

  return { uuid, imageWidth, imageHeight, fileSize: full.length, grid, fingerprint };
}

export interface RescaledImage {
  full: Uint8Array;
  thumb: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  fileSize: number;
  fingerprint: string;
}

/**
 * Re-encodes an already-stored map at a new size, for when an edit changes the
 * square counts and the grid no longer divides the image exactly.
 *
 * Nothing is written: the buffers come back so the caller can commit the row
 * first and only overwrite the files once that has succeeded. There is no
 * pristine original to work from, so repeated edits resample the previous
 * output — see `upscale_factor`, which the caller accumulates.
 */
export async function rescaleStored(uuid: string, target: TargetSize): Promise<RescaledImage> {
  assertWebpEncodable(target.width, target.height);

  const source = await imageFile(uuid, 'full').bytes();

  // No `.rotate()`: the stored file was normalised when it was uploaded and
  // carries no EXIF orientation of its own.
  const full = await sharp(source, { limitInputPixels: config.maxImagePixels })
    .resize({ width: target.width, height: target.height, kernel: 'lanczos3', fit: 'fill' })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();

  const thumb = await makeThumbnail(full);
  const meta = await sharp(full).metadata();
  // Re-taken so the column keeps describing the file on disk. A resize this
  // small barely moves the hash, which is the point — the map is still findable
  // as a near-duplicate of whatever it was a near-duplicate of before.
  const fingerprint = await fingerprintImage(full);

  log.info('image rescaled', {
    uuid,
    imageWidth: meta.width ?? target.width,
    imageHeight: meta.height ?? target.height,
    storedBytes: full.length,
    fingerprint,
  });

  return {
    full,
    thumb,
    imageWidth: meta.width ?? target.width,
    imageHeight: meta.height ?? target.height,
    fileSize: full.length,
    fingerprint,
  };
}

/** Lossy by design — a lossless preview would be pointlessly large. */
function makeThumbnail(full: Uint8Array): Promise<Buffer> {
  return sharp(full, { limitInputPixels: config.maxImagePixels })
    .resize({
      width: config.thumbSize,
      height: config.thumbSize,
      fit: 'inside',
      // Never enlarge a small map just to fill the thumbnail box.
      withoutEnlargement: true,
      kernel: 'lanczos3',
    })
    .webp({ quality: config.thumbQuality })
    .toBuffer();
}

function assertWebpEncodable(width: number, height: number): void {
  if (width > WEBP_MAX_DIMENSION || height > WEBP_MAX_DIMENSION) {
    throw badRequest(
      `That image is ${width}×${height} pixels. WEBP supports at most ${WEBP_MAX_DIMENSION} pixels on a side, ` +
        `so please scale it down before uploading.`,
    );
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { fitGridToCounts, solveIntegerUpscale };
