/** Format sniffing, WEBP conversion, lossless guarantee, and sharded storage. */
import { beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import { config } from '../src/config.ts';
import { processUpload, rescaleStored, sniffFormat } from '../src/images/process.ts';
import { fullImagePath, isValidUuid, shardFor, thumbImagePath } from '../src/images/storage.ts';
import { ensureSchema, makeMapPng } from './helpers.ts';

beforeAll(ensureSchema);

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
  test('stores lossless WEBP that is pixel-identical to the source', async () => {
    const png = await makeMapPng(280, 210, 70);
    const result = await processUpload(png, { grid: {} });

    const storedPath = fullImagePath(result.uuid);
    const metadata = await sharp(storedPath).metadata();
    expect(metadata.format).toBe('webp');

    const before = await sharp(png).raw().toBuffer();
    const after = await sharp(storedPath).raw().toBuffer();
    expect(Buffer.compare(before, after)).toBe(0);
  });

  test('assigns a UUID v4 and shards on its first two characters', async () => {
    const result = await processUpload(await makeMapPng(), { grid: {} });

    expect(isValidUuid(result.uuid)).toBe(true);
    expect(shardFor(result.uuid)).toBe(result.uuid.slice(0, 2));
    expect(fullImagePath(result.uuid)).toContain(`/${result.uuid.slice(0, 2)}/`);
  });

  test('writes both a full-resolution file and a thumbnail', async () => {
    const result = await processUpload(await makeMapPng(280, 210, 70), { grid: {} });

    expect(await Bun.file(fullImagePath(result.uuid)).exists()).toBe(true);
    expect(await Bun.file(thumbImagePath(result.uuid)).exists()).toBe(true);

    const thumb = await sharp(thumbImagePath(result.uuid)).metadata();
    expect(thumb.format).toBe('webp');
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(config.thumbSize);
  });

  test('does not enlarge an image smaller than the thumbnail box', async () => {
    const result = await processUpload(await makeMapPng(100, 80, 20), { grid: {} });
    const thumb = await sharp(thumbImagePath(result.uuid)).metadata();
    expect(thumb.width).toBe(100);
    expect(thumb.height).toBe(80);
  });

  test('records the true pixel dimensions and stored file size', async () => {
    const result = await processUpload(await makeMapPng(280, 210, 70), { grid: {} });
    expect(result.imageWidth).toBe(280);
    expect(result.imageHeight).toBe(210);
    expect(result.fileSize).toBe((await Bun.file(fullImagePath(result.uuid)).arrayBuffer()).byteLength);
  });

  test('converts JPEG input to WEBP', async () => {
    const jpeg = await sharp(await makeMapPng(280, 210, 70)).jpeg({ quality: 95 }).toBuffer();
    const result = await processUpload(jpeg, { grid: {} });
    expect((await sharp(fullImagePath(result.uuid)).metadata()).format).toBe('webp');
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

    const stored = await sharp(fullImagePath(result.uuid)).metadata();
    expect(stored.width).toBe(1020);
    expect(stored.height).toBe(1020);
  });

  test('leaves the file alone when the counts already divide it evenly', async () => {
    const result = await processUpload(await makeMapPng(280, 210, 70), { grid: { gridWidth: 4, gridHeight: 3 } });

    expect(result.grid).toMatchObject({ gridSize: 70, target: null, upscaleFactor: 1 });
    expect(result.imageWidth).toBe(280);
  });

  test('leaves the grid unrecorded when nothing was supplied', async () => {
    const result = await processUpload(await makeMapPng(), { grid: {} });
    expect(result.grid).toMatchObject({ gridSize: null, source: 'none', upscaleFactor: 1 });
  });

  test('strips metadata, so an embedded payload cannot survive the round trip', async () => {
    const png = await makeMapPng(140, 140, 70);
    const withExif = await sharp(png)
      .withMetadata({ exif: { IFD0: { Copyright: 'SUSPICIOUS-PAYLOAD-MARKER' } } })
      .jpeg()
      .toBuffer();

    const result = await processUpload(withExif, { grid: {} });
    const stored = await Bun.file(fullImagePath(result.uuid)).arrayBuffer();
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

describe('rescaleStored', () => {
  test('re-encodes an existing map at the new size without writing it', async () => {
    const uploaded = await processUpload(await makeMapPng(280, 210, 70), { grid: {} });
    const before = await Bun.file(fullImagePath(uploaded.uuid)).arrayBuffer();

    const rescaled = await rescaleStored(uploaded.uuid, { width: 300, height: 225 });

    expect(rescaled.imageWidth).toBe(300);
    expect(rescaled.imageHeight).toBe(225);
    expect(rescaled.fileSize).toBe(rescaled.full.length);
    expect((await sharp(rescaled.full).metadata()).format).toBe('webp');

    // The caller commits the row first, so nothing on disk has moved yet.
    const after = await Bun.file(fullImagePath(uploaded.uuid)).arrayBuffer();
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0);
  });

  test('refuses a size WEBP cannot encode', async () => {
    const uploaded = await processUpload(await makeMapPng(100, 80, 20), { grid: {} });
    expect(rescaleStored(uploaded.uuid, { width: 20_000, height: 80 })).rejects.toThrow(/WEBP supports at most/);
  });
});

describe('storage paths', () => {
  test('refuse to be built from anything that is not a UUID v4', () => {
    for (const bad of ['../../etc/passwd', 'not-a-uuid', '', '00000000-0000-1000-8000-000000000000']) {
      expect(() => fullImagePath(bad)).toThrow(/non-UUID/);
    }
  });

  test('stay inside the configured image directory', async () => {
    const result = await processUpload(await makeMapPng(), { grid: {} });
    expect(fullImagePath(result.uuid).startsWith(config.imageDir)).toBe(true);
    expect(thumbImagePath(result.uuid).startsWith(config.imageDir)).toBe(true);
  });
});
