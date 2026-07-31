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
import { resolveGrid, solveIntegerUpscale, type GridInput, type ResolvedGrid } from './grid.ts';
import { storeImage } from './storage.ts';

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

  // Decide the grid before encoding, because a detected fractional grid can
  // call for an upscale that changes the dimensions written to disk.
  const grid = resolveGrid(options.grid, { width: sourceWidth, height: sourceHeight });

  let outputWidth = sourceWidth;
  let outputHeight = sourceHeight;
  let upscaleFactor = 1;

  if (grid.upscaleFactor > 1) {
    upscaleFactor = grid.upscaleFactor;
    outputWidth = Math.round(sourceWidth * upscaleFactor);
    outputHeight = Math.round(sourceHeight * upscaleFactor);
  }

  assertWebpEncodable(outputWidth, outputHeight);

  // `.rotate()` with no argument applies the EXIF orientation, so a photo of a
  // battle map is stored the way it was taken. Re-encoding also drops every
  // other metadata block, including anything malicious hidden in one.
  let output = sharp(bytes, { limitInputPixels: config.maxImagePixels }).rotate();

  if (upscaleFactor > 1) {
    output = output.resize({ width: outputWidth, height: outputHeight, kernel: 'lanczos3', fit: 'fill' });
  }

  const full = await output.webp({ lossless: true, effort: 4 }).toBuffer();

  const thumb = await sharp(full, { limitInputPixels: config.maxImagePixels })
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
    upscaleFactor,
    gridSource: grid.source,
  });

  return { uuid, imageWidth, imageHeight, fileSize: full.length, grid };
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

export { solveIntegerUpscale };
