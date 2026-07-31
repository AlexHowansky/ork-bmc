/** Perceptual hashing: what it treats as the same picture, and what it does not. */
import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import {
  ANALYSIS_SIZE,
  FINGERPRINT_BITS,
  FINGERPRINT_HEX_LENGTH,
  fingerprintImage,
  hammingDistance,
  isSimilar,
  isValidFingerprint,
  perceptualHash,
} from '../src/images/fingerprint.ts';
import { makeMapPng } from './helpers.ts';

/** A greyscale plane of the size `perceptualHash` expects. */
const plane = (fill: (x: number, y: number) => number): Uint8Array => {
  const data = new Uint8Array(ANALYSIS_SIZE * ANALYSIS_SIZE);
  for (let y = 0; y < ANALYSIS_SIZE; y++) {
    for (let x = 0; x < ANALYSIS_SIZE; x++) {
      data[y * ANALYSIS_SIZE + x] = Math.max(0, Math.min(255, Math.round(fill(x, y))));
    }
  }
  return data;
};

const hashOf = (fill: (x: number, y: number) => number): string =>
  perceptualHash({ data: plane(fill), width: ANALYSIS_SIZE, height: ANALYSIS_SIZE });

describe('perceptualHash', () => {
  test('produces 16 lowercase hex characters', () => {
    const hash = hashOf((x, y) => x * 4 + y * 2);

    expect(hash).toHaveLength(FINGERPRINT_HEX_LENGTH);
    expect(isValidFingerprint(hash)).toBe(true);
  });

  test('is deterministic', () => {
    const fill = (x: number, y: number) => (x % 7) * 30 + (y % 5) * 20;

    expect(hashOf(fill)).toBe(hashOf(fill));
  });

  test('an image with no structure hashes to zero, whatever its brightness', () => {
    // Two blank fills are the same picture. Left to the arithmetic they would
    // differ, because all that separates them is floating-point noise around a
    // median of zero.
    expect(hashOf(() => 40)).toBe('0'.repeat(FINGERPRINT_HEX_LENGTH));
    expect(hashOf(() => 200)).toBe(hashOf(() => 40));
  });

  test('sets half the bits, because the threshold is the median', () => {
    // Whatever the image, 32 of the 64 coefficients are above their own median.
    // A hash that was mostly zeroes or mostly ones would carry far less signal.
    for (const fill of [
      (x: number, y: number) => x * 8 + y,
      (x: number, y: number) => Math.sin(x / 3) * 120 + Math.cos(y / 5) * 100 + 128,
      (x: number) => (x < ANALYSIS_SIZE / 2 ? 20 : 230),
    ]) {
      const bits = [...hashOf(fill)].reduce((n, digit) => n + (POPCOUNT[parseInt(digit, 16)] ?? 0), 0);
      expect(bits).toBe(FINGERPRINT_BITS / 2);
    }
  });

  test('rejects a plane that is not the size it analyses', () => {
    expect(() => perceptualHash({ data: new Uint8Array(4), width: 2, height: 2 })).toThrow(/32×32/);
    expect(() =>
      perceptualHash({ data: new Uint8Array(16), width: ANALYSIS_SIZE, height: ANALYSIS_SIZE }),
    ).toThrow(/one channel/);
  });
});

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

describe('hammingDistance', () => {
  test('counts the differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(FINGERPRINT_BITS);
    expect(hammingDistance('00000000000000ff', '000000000000000f')).toBe(4);
  });

  test('is symmetric', () => {
    const a = 'eeec851f3f931300';
    const b = 'c2c23c2787b32d3d';

    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  test('refuses anything that is not a fingerprint', () => {
    // Returning 0 for junk would report every map as a duplicate of every other.
    for (const bad of ['', 'abc', 'EEEC851F3F931300', 'zzzzzzzzzzzzzzzz', '0'.repeat(17)]) {
      expect(() => hammingDistance('0000000000000000', bad)).toThrow(/fingerprint/i);
    }
  });
});

describe('fingerprintImage', () => {
  test('two encodings of one map fingerprint identically', async () => {
    const png = await makeMapPng(1000, 1000, 100, 1001);

    expect(await fingerprintImage(png)).toBe(await fingerprintImage(png));
  });

  // The point of a perceptual hash: these are all the same map, and the library
  // should say so. The upscale case is the one the app produces itself, when a
  // square count does not divide the image evenly.
  const transforms: [string, (image: Buffer) => { toBuffer(): Promise<Buffer> }][] = [
    ['the grid-fitting upscale', (image) => sharp(image).resize({ width: 1020, height: 1020, fit: 'fill', kernel: 'lanczos3' })],
    ['a doubling', (image) => sharp(image).resize({ width: 2000, height: 2000, fit: 'fill', kernel: 'lanczos3' })],
    ['a halving', (image) => sharp(image).resize({ width: 500, height: 500, fit: 'fill' })],
    ['heavy JPEG compression', (image) => sharp(image).jpeg({ quality: 30 })],
    ['a brightness change', (image) => sharp(image).modulate({ brightness: 1.25 })],
  ];

  for (const [label, transform] of transforms) {
    test(`survives ${label}`, async () => {
      const png = await makeMapPng(1000, 1000, 100, 2002);
      const original = await fingerprintImage(png);
      const changed = await fingerprintImage(await transform(png).toBuffer());

      expect(hammingDistance(original, changed)).toBeLessThanOrEqual(8);
      expect(isSimilar(original, changed)).toBe(true);
    });
  }

  test('two different maps are nowhere near each other', async () => {
    const a = await fingerprintImage(await makeMapPng(1000, 1000, 100, 3003));
    const b = await fingerprintImage(await makeMapPng(1000, 1000, 100, 4004));

    expect(hammingDistance(a, b)).toBeGreaterThan(20);
    expect(isSimilar(a, b)).toBe(false);
  });

  test('the seeded test fixtures are all distinct maps', async () => {
    // The whole suite relies on this: an upload fixture that repeated itself
    // would trip the duplicate check in tests that are about something else.
    const hashes = [];
    for (let seed = 1; seed <= 10; seed++) {
      hashes.push(await fingerprintImage(await makeMapPng(280, 210, 70, seed)));
    }

    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) {
        expect(isSimilar(hashes[i]!, hashes[j]!)).toBe(false);
      }
    }
  });
});
