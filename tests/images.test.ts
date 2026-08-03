/** Format sniffing, the configured encoder, and sharded storage. */
import { beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import { config, loadConfig } from '../src/config.ts';
import { fingerprintImage, hammingDistance } from '../src/images/fingerprint.ts';
import { encodeAs, processUpload, rescaleStored, sniffFormat } from '../src/images/process.ts';
import { fullImagePath, isValidUuid, shardFor, thumbImagePath } from '../src/images/storage.ts';
import { ensureSchema, makeMapPng, makePlainPng } from './helpers.ts';

beforeAll(ensureSchema);

/**
 * Most of this file holds whatever IMAGE_FORMAT is set to, so the suite can be
 * run under any of them. The pixel-fidelity check is the exception: it is a
 * claim about the shipped defaults, and running deliberately lossy settings is
 * a decision to give exactly that up.
 */
const defaults = loadConfig({}).image;
const isDefaultEncoding =
  config.image.format === defaults.format &&
  config.image.quality === defaults.quality &&
  config.image.lossless === defaults.lossless;

describe('sniffFormat', () => {
  test('recognises PNG, JPEG and WEBP from their leading bytes', async () => {
    const png = await makeMapPng(70, 70, 35);
    const jpeg = await sharp(png).jpeg().toBuffer();
    const webp = await sharp(png).webp().toBuffer();

    expect(sniffFormat(png)).toBe('png');
    expect(sniffFormat(jpeg)).toBe('jpeg');
    expect(sniffFormat(webp)).toBe('webp');
  });

  test('rejects non-images, however they are labelled', () => {
    expect(sniffFormat(new TextEncoder().encode('<?php system($_GET[0]); ?>'))).toBeNull();
    expect(sniffFormat(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(sniffFormat(new Uint8Array([0, 1, 2, 3]))).toBeNull();
    expect(sniffFormat(new Uint8Array(0))).toBeNull();
  });

  test('is not fooled by a truncated RIFF header', () => {
    // "RIFF" present but no "WEBP" marker.
    expect(sniffFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0, 0, 0, 0]))).toBeNull();
  });
});

describe('processUpload', () => {
  test('stores the configured format, and says which one it used', async () => {
    const png = await makeMapPng(280, 210, 70);
    const result = await processUpload(png, { grid: {} });

    expect(result.format).toBe(config.image.format);

    const metadata = await sharp(fullImagePath(result.uuid, result.format)).metadata();
    expect(metadata.format).toBe(config.image.format);
  });

  test('stores an image that still fingerprints as the same map', async () => {
    const png = await makeMapPng(280, 210, 70);
    const result = await processUpload(png, { grid: {} });

    // True at any setting an operator can choose, and it has to be: a storage
    // format lossy enough to move the hash past this would quietly break
    // duplicate detection for every map uploaded after the change.
    const drift = hammingDistance(await fingerprintImage(png), result.fingerprint);
    expect(drift).toBeLessThanOrEqual(config.fingerprint.maxDistance);
  });

  test.skipIf(!isDefaultEncoding)('keeps the stored pixels faithful at the default settings', async () => {
    const png = await makeMapPng(280, 210, 70);
    const result = await processUpload(png, { grid: {} });

    // Not bit-exact unless IMAGE_LOSSLESS is set — see the encodeAs tests below
    // for that guarantee. What matters here is that the map still looks right.
    const before = await sharp(png).raw().toBuffer();
    const after = await sharp(fullImagePath(result.uuid, result.format)).raw().toBuffer();
    expect(after.length).toBe(before.length);

    let total = 0;
    for (let i = 0; i < before.length; i++) {
      total += Math.abs(before[i]! - after[i]!);
    }
    // Averaged over the whole image, because the default quality is not
    // bit-exact: a hard grid line moves by a lot in a handful of pixels, which a
    // worst-case bound would report and an eye would not.
    expect(total / before.length).toBeLessThan(2);
  });

  test('assigns a UUID v4 and shards on its first two characters', async () => {
    const result = await processUpload(await makeMapPng(), { grid: {} });

    expect(isValidUuid(result.uuid)).toBe(true);
    expect(shardFor(result.uuid)).toBe(result.uuid.slice(0, 2));
    expect(fullImagePath(result.uuid, result.format)).toContain(`/${result.uuid.slice(0, 2)}/`);
  });

  test('writes both a full-resolution file and a thumbnail', async () => {
    const result = await processUpload(await makeMapPng(280, 210, 70), { grid: {} });

    expect(await Bun.file(fullImagePath(result.uuid, result.format)).exists()).toBe(true);
    expect(await Bun.file(thumbImagePath(result.uuid, result.format)).exists()).toBe(true);

    const thumb = await sharp(thumbImagePath(result.uuid, result.format)).metadata();
    // Same format as the map, so one recorded format describes both files.
    expect(thumb.format).toBe(result.format);
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(config.thumbSize);
  });

  test('does not enlarge an image smaller than the thumbnail box', async () => {
    const result = await processUpload(await makeMapPng(100, 80, 20), { grid: {} });
    const thumb = await sharp(thumbImagePath(result.uuid, result.format)).metadata();
    expect(thumb.width).toBe(100);
    expect(thumb.height).toBe(80);
  });

  test('records the true pixel dimensions and stored file size', async () => {
    const result = await processUpload(await makeMapPng(280, 210, 70), { grid: {} });
    expect(result.imageWidth).toBe(280);
    expect(result.imageHeight).toBe(210);
    expect(result.fileSize).toBe((await Bun.file(fullImagePath(result.uuid, result.format)).arrayBuffer()).byteLength);
  });

  test('converts JPEG input to the storage format', async () => {
    const jpeg = await sharp(await makeMapPng(280, 210, 70)).jpeg({ quality: 95 }).toBuffer();
    const result = await processUpload(jpeg, { grid: {} });
    expect((await sharp(fullImagePath(result.uuid, result.format)).metadata()).format).toBe(config.image.format);
  });

  test('carries the grid arithmetic through to the stored metadata', async () => {
    const result = await processUpload(await makeMapPng(280, 210, 70), { grid: { gridSize: 70 } });
    expect(result.grid).toMatchObject({ gridSize: 70, gridWidth: 4, gridHeight: 3, source: 'user' });
  });

  test('enlarges the stored file so counted squares land on whole pixels', async () => {
    // 1000 / 30 = 33.33…, so 34px squares across a 1020px image.
    const result = await processUpload(await makeMapPng(1000, 1000, 100), {
      grid: { gridWidth: 30, gridHeight: 30 },
    });

    expect(result.grid).toMatchObject({ gridSize: 34, gridWidth: 30, gridHeight: 30, source: 'user' });
    expect(result.imageWidth).toBe(1020);
    expect(result.imageHeight).toBe(1020);

    const stored = await sharp(fullImagePath(result.uuid, result.format)).metadata();
    expect(stored.width).toBe(1020);
    expect(stored.height).toBe(1020);
  });

  test('leaves the file alone when the counts already divide it evenly', async () => {
    const result = await processUpload(await makeMapPng(280, 210, 70), { grid: { gridWidth: 4, gridHeight: 3 } });

    expect(result.grid).toMatchObject({ gridSize: 70, target: null, upscaleFactor: 1 });
    expect(result.imageWidth).toBe(280);
  });

  test('leaves the grid unrecorded when nothing was supplied and nothing is painted', async () => {
    const result = await processUpload(await makePlainPng(), { grid: {} });
    expect(result.grid).toMatchObject({ gridSize: null, source: 'none', upscaleFactor: 1 });
  });

  test('measures the painted grid when nothing was supplied', async () => {
    const result = await processUpload(await makeMapPng(1000, 800, 50), { grid: {} });

    expect(result.grid).toMatchObject({
      gridSize: 50,
      gridWidth: 20,
      gridHeight: 16,
      source: 'detected',
      upscaleFactor: 1,
    });
    // A measurement that lands on a whole number of pixels asks for no
    // enlargement, so the file is stored at the size it arrived at.
    expect(result.imageWidth).toBe(1000);
    expect(result.imageHeight).toBe(800);
  });

  test('does not measure the image when the grid was given', async () => {
    // A 50px grid is painted, but 40 squares across 1000px is 25px, and what the
    // admin says goes.
    const result = await processUpload(await makeMapPng(1000, 800, 50), { grid: { gridWidth: 40 } });
    expect(result.grid).toMatchObject({ gridSize: 25, gridWidth: 40, source: 'user' });
  });

  test('strips metadata, so an embedded payload cannot survive the round trip', async () => {
    const png = await makeMapPng(140, 140, 70);
    const withExif = await sharp(png)
      .withMetadata({ exif: { IFD0: { Copyright: 'SUSPICIOUS-PAYLOAD-MARKER' } } })
      .jpeg()
      .toBuffer();

    const result = await processUpload(withExif, { grid: {} });
    const stored = await Bun.file(fullImagePath(result.uuid, result.format)).arrayBuffer();
    expect(Buffer.from(stored).includes('SUSPICIOUS-PAYLOAD-MARKER')).toBe(false);
  });

  describe('rejections', () => {
    test('an empty file', async () => {
      expect(processUpload(new Uint8Array(0), { grid: {} })).rejects.toThrow(/empty/i);
    });

    test('a file that is not an image', async () => {
      const text = new TextEncoder().encode('this is definitely not a png');
      expect(processUpload(text, { grid: {} })).rejects.toThrow(/not a PNG, JPG, or WEBP/i);
    });

    test('a file over the configured size limit', async () => {
      const oversized = new Uint8Array(config.maxUploadBytes + 1);
      // A valid PNG signature, so it is the size check that rejects it.
      oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(processUpload(oversized, { grid: {} })).rejects.toThrow(/limit/i);
    });

    test('a PNG signature with corrupt contents', async () => {
      const corrupt = new Uint8Array(512);
      corrupt.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(processUpload(corrupt, { grid: {} })).rejects.toThrow(/could not be read|corrupt/i);
    });
  });
});

/**
 * `config.image` is read once at import time, so these drive the encoder
 * directly rather than trying to re-load the module under a different
 * environment. It is the same function `processUpload` hands its pipeline to.
 */
describe('encodeAs', () => {
  const source = () => makeMapPng(140, 140, 70);

  test('writes each configured format, and nothing else', async () => {
    for (const format of ['webp', 'png', 'jpeg'] as const) {
      const encoded = await encodeAs(sharp(await source()), { format, quality: 90, lossless: false }).toBuffer();

      expect(sniffFormat(encoded)).toBe(format);
      expect((await sharp(encoded).metadata()).format).toBe(format);
    }
  });

  test('lossless WEBP round-trips the pixels exactly', async () => {
    const png = await source();
    const encoded = await encodeAs(sharp(png), { format: 'webp', quality: 100, lossless: true }).toBuffer();

    const before = await sharp(png).raw().toBuffer();
    const after = await sharp(encoded).raw().toBuffer();
    expect(Buffer.compare(before, after)).toBe(0);
  });

  test('PNG round-trips exactly too, whatever the lossless flag says', async () => {
    const png = await source();
    const encoded = await encodeAs(sharp(png), { format: 'png', quality: 100, lossless: false }).toBuffer();

    const before = await sharp(png).raw().toBuffer();
    const after = await sharp(encoded).raw().toBuffer();
    expect(Buffer.compare(before, after)).toBe(0);
  });

  test('quality below 100 costs bytes rather than being ignored', async () => {
    const png = await source();

    const full = await encodeAs(sharp(png), { format: 'jpeg', quality: 100, lossless: false }).toBuffer();
    const thrifty = await encodeAs(sharp(png), { format: 'jpeg', quality: 40, lossless: false }).toBuffer();
    expect(thrifty.length).toBeLessThan(full.length);

    // For PNG the only lever is palette quantisation, which still has to shrink
    // the file or the setting would be a lie.
    const pngFull = await encodeAs(sharp(png), { format: 'png', quality: 100, lossless: false }).toBuffer();
    const pngPalette = await encodeAs(sharp(png), { format: 'png', quality: 40, lossless: false }).toBuffer();
    expect(pngPalette.length).toBeLessThan(pngFull.length);
  });
});

describe('rescaleStored', () => {
  test('re-encodes an existing map at the new size without writing it', async () => {
    const uploaded = await processUpload(await makeMapPng(280, 210, 70), { grid: {} });
    const before = await Bun.file(fullImagePath(uploaded.uuid, uploaded.format)).arrayBuffer();

    const rescaled = await rescaleStored(uploaded.uuid, { width: 300, height: 225 }, uploaded.format);

    expect(rescaled.imageWidth).toBe(300);
    expect(rescaled.imageHeight).toBe(225);
    expect(rescaled.fileSize).toBe(rescaled.full.length);
    expect((await sharp(rescaled.full).metadata()).format).toBe(uploaded.format);

    // The caller commits the row first, so nothing on disk has moved yet.
    const after = await Bun.file(fullImagePath(uploaded.uuid, uploaded.format)).arrayBuffer();
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0);
  });

  test('refuses a size WEBP cannot encode', async () => {
    const uploaded = await processUpload(await makeMapPng(100, 80, 20), { grid: {} });
    expect(rescaleStored(uploaded.uuid, { width: 20_000, height: 80 }, 'webp')).rejects.toThrow(/WEBP supports at most/);
  });
});

describe('storage paths', () => {
  test('refuse to be built from anything that is not a UUID v4', () => {
    for (const bad of ['../../etc/passwd', 'not-a-uuid', '', '00000000-0000-1000-8000-000000000000']) {
      expect(() => fullImagePath(bad, 'webp')).toThrow(/non-UUID/);
    }
  });

  test('stay inside the configured image directory', async () => {
    const result = await processUpload(await makeMapPng(), { grid: {} });
    expect(fullImagePath(result.uuid, result.format).startsWith(config.imageDir)).toBe(true);
    expect(thumbImagePath(result.uuid, result.format).startsWith(config.imageDir)).toBe(true);
  });

  test('name the file after the format it holds', async () => {
    const result = await processUpload(await makeMapPng(), { grid: {} });

    expect(fullImagePath(result.uuid, 'webp')).toEndWith('.webp');
    expect(fullImagePath(result.uuid, 'png')).toEndWith('.png');
    expect(fullImagePath(result.uuid, 'jpeg')).toEndWith('.jpg');
    expect(thumbImagePath(result.uuid, 'png')).toEndWith('_thumb.png');
  });
});
