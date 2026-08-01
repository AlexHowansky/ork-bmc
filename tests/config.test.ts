/**
 * Configuration parsing.
 *
 * `loadConfig` takes the environment as an argument precisely so this can be
 * exercised without touching the process's own.
 */
import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../src/config.ts';

/** Only the keys under test; everything else falls back to its default. */
const load = (env: Record<string, string>) => loadConfig(env);

describe('image storage settings', () => {
  test('default to WEBP at quality 100, not lossless', () => {
    expect(load({}).image).toEqual({ format: 'webp', quality: 100, lossless: false });
  });

  test('accept each supported format, and "jpg" as a spelling of "jpeg"', () => {
    expect(load({ IMAGE_FORMAT: 'png' }).image.format).toBe('png');
    expect(load({ IMAGE_FORMAT: 'JPEG' }).image.format).toBe('jpeg');
    expect(load({ IMAGE_FORMAT: 'jpg' }).image.format).toBe('jpeg');
    expect(load({ IMAGE_FORMAT: ' WebP ' }).image.format).toBe('webp');
  });

  test('refuse a format nothing can read', () => {
    expect(() => load({ IMAGE_FORMAT: 'gif' })).toThrow(/IMAGE_FORMAT must be one of/);
    expect(() => load({ IMAGE_FORMAT: 'tiff' })).toThrow(/IMAGE_FORMAT/);
  });

  test('read quality and the lossless flag', () => {
    expect(load({ IMAGE_QUALITY: '82' }).image.quality).toBe(82);
    expect(load({ IMAGE_LOSSLESS: 'true' }).image.lossless).toBe(true);
    expect(load({ IMAGE_LOSSLESS: 'no' }).image.lossless).toBe(false);
  });

  test('refuse a quality outside 1–100', () => {
    expect(() => load({ IMAGE_QUALITY: '0' })).toThrow(/IMAGE_QUALITY must be at least 1/);
    expect(() => load({ IMAGE_QUALITY: '101' })).toThrow(/IMAGE_QUALITY must be at most 100/);
    expect(() => load({ IMAGE_QUALITY: 'best' })).toThrow(/IMAGE_QUALITY must be a number/);
  });

  test('refuse lossless JPEG rather than quietly storing a lossy file', () => {
    expect(() => load({ IMAGE_FORMAT: 'jpeg', IMAGE_LOSSLESS: 'true' })).toThrow(/JPEG is always lossy/);
    // The same flag is fine for the formats that can honour it.
    expect(load({ IMAGE_FORMAT: 'webp', IMAGE_LOSSLESS: 'true' }).image.lossless).toBe(true);
    expect(load({ IMAGE_FORMAT: 'png', IMAGE_LOSSLESS: 'true' }).image.lossless).toBe(true);
  });

  test('report every problem at once, so one boot fixes them all', () => {
    try {
      load({ IMAGE_FORMAT: 'gif', IMAGE_QUALITY: '900' });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('IMAGE_FORMAT');
      expect(message).toContain('IMAGE_QUALITY');
    }
  });
});
