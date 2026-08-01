/**
 * Upload processing: validate, normalise, re-encode, thumbnail.
 *
 * What a stored map is encoded as comes from IMAGE_FORMAT, IMAGE_QUALITY and
 * IMAGE_LOSSLESS — see `encodeSettings` below for what each format does with
 * them. The defaults are WEBP at quality 100, which is visually indistinguishable
 * from the source but not bit-exact; set IMAGE_LOSSLESS=true for that.
 *
 * Thumbnails are a separate derived preview and are lossy by design at
 * THUMB_QUALITY — a lossless thumbnail would be pointlessly large — but they are
 * written in the same format as the map, so both files can be served with one
 * recorded Content-Type.
 */
import sharp, { type Sharp } from 'sharp';

import { config, type ImageFormat } from '../config.ts';
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

/**
 * The largest dimension each format can represent.
 *
 * WEBP's 16,383 is the tight one and the reason this check exists at all; PNG's
 * limit is theoretical, and MAX_IMAGE_PIXELS bites long before it.
 */
const MAX_DIMENSION: Record<ImageFormat, number> = {
  webp: 16_383,
  jpeg: 65_535,
  png: 2_147_483_647,
};

export type DetectedFormat = ImageFormat;

/** How a format is spelled for a human. */
export const FORMAT_LABELS: Record<ImageFormat, string> = { webp: 'WEBP', png: 'PNG', jpeg: 'JPEG' };

export const FORMAT_MIME_TYPES: Record<ImageFormat, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

export interface EncodeSettings {
  format: ImageFormat;
  quality: number;
  lossless: boolean;
}

/**
 * Applies the configured encoder to a pipeline.
 *
 * Each format reads the settings differently, and pretending otherwise would
 * quietly mislead: WEBP is the only one with a lossless switch, PNG is lossless
 * whatever the flag says and can only spend quality through palette
 * quantisation, and JPEG has quality alone. Refusing lossless JPEG happens at
 * boot, in `loadConfig`, rather than here.
 */
export function encodeAs(pipeline: Sharp, settings: EncodeSettings): Sharp {
  switch (settings.format) {
    case 'webp':
      return pipeline.webp({ quality: settings.quality, lossless: settings.lossless, effort: 4 });
    case 'jpeg':
      return pipeline.jpeg({ quality: settings.quality });
    case 'png':
      return settings.quality < 100
        ? pipeline.png({ compressionLevel: 9, palette: true, quality: settings.quality })
        : pipeline.png({ compressionLevel: 9 });
  }
}

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
  /**
   * What was actually written, which is the configured format at the moment of
   * the upload. Recorded on the row rather than re-read from the config later,
   * so changing IMAGE_FORMAT never invalidates a map already in the library.
   */
  format: ImageFormat;
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

  assertEncodable(outputWidth, outputHeight, config.image.format);

  // `.rotate()` with no argument applies the EXIF orientation, so a photo of a
  // battle map is stored the way it was taken. Re-encoding also drops every
  // other metadata block, including anything malicious hidden in one.
  let output = sharp(bytes, { limitInputPixels: config.maxImagePixels }).rotate();

  if (grid.target) {
    output = output.resize({ width: outputWidth, height: outputHeight, kernel: 'lanczos3', fit: 'fill' });
  }

  const full = await encodeAs(output, config.image).toBuffer();
  const thumb = await makeThumbnail(full);

  // Taken from the encoded output rather than the source bytes, so the stored
  // fingerprint always describes the file that is actually on disk — including
  // any enlargement the grid called for. The hash is computed from a 32×32
  // reduction, so that enlargement makes almost no difference to it.
  const fingerprint = await fingerprintImage(full);

  await storeImage(uuid, full, thumb, config.image.format);

  // Rotation can transpose the dimensions, so read them back from the encoded
  // output rather than assuming what went in.
  const finalMeta = await sharp(full).metadata();
  const imageWidth = finalMeta.width ?? outputWidth;
  const imageHeight = finalMeta.height ?? outputHeight;

  log.info('image processed', {
    uuid,
    sourceFormat: format,
    storedFormat: config.image.format,
    quality: config.image.quality,
    lossless: config.image.lossless,
    sourceBytes: bytes.length,
    storedBytes: full.length,
    imageWidth,
    imageHeight,
    upscaleFactor: grid.upscaleFactor,
    gridSource: grid.source,
    fingerprint,
  });

  return {
    uuid,
    imageWidth,
    imageHeight,
    fileSize: full.length,
    grid,
    fingerprint,
    format: config.image.format,
  };
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
 *
 * The map keeps the format it was stored in, even if IMAGE_FORMAT has changed
 * since: an edit to the square counts is not a request to convert the library,
 * and rewriting it under a new extension would leave the old file behind. The
 * quality and lossless settings are read fresh, because those are policy rather
 * than a property of the file.
 */
export async function rescaleStored(uuid: string, target: TargetSize, format: ImageFormat): Promise<RescaledImage> {
  assertEncodable(target.width, target.height, format);

  const source = await imageFile(uuid, 'full', format).bytes();

  // No `.rotate()`: the stored file was normalised when it was uploaded and
  // carries no EXIF orientation of its own.
  const resized = sharp(source, { limitInputPixels: config.maxImagePixels }).resize({
    width: target.width,
    height: target.height,
    kernel: 'lanczos3',
    fit: 'fill',
  });

  const full = await encodeAs(resized, { ...config.image, format }).toBuffer();

  const thumb = await makeThumbnail(full, format);
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

/**
 * Lossy by design at THUMB_QUALITY — a lossless preview would be pointlessly
 * large — but in the map's own format, so one recorded format describes both
 * files and neither route has to guess a Content-Type.
 */
function makeThumbnail(full: Uint8Array, format: ImageFormat = config.image.format): Promise<Buffer> {
  const resized = sharp(full, { limitInputPixels: config.maxImagePixels }).resize({
    width: config.thumbSize,
    height: config.thumbSize,
    fit: 'inside',
    // Never enlarge a small map just to fill the thumbnail box.
    withoutEnlargement: true,
    kernel: 'lanczos3',
  });

  return encodeAs(resized, { format, quality: config.thumbQuality, lossless: false }).toBuffer();
}

function assertEncodable(width: number, height: number, format: ImageFormat): void {
  const limit = MAX_DIMENSION[format];
  if (width > limit || height > limit) {
    throw badRequest(
      `That image is ${width}×${height} pixels. ${FORMAT_LABELS[format]} supports at most ${limit} pixels on a ` +
        `side, so please scale it down before uploading.`,
    );
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { fitGridToCounts, solveIntegerUpscale };
