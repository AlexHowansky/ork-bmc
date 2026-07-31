/**
 * Grid geometry.
 *
 * Automatic detection is deferred, so these cover the parts that exist: the
 * capped integer-upscale solver, and the arithmetic that fills in whichever
 * values the admin did not type. Detector tests arrive with the detector.
 */
import { describe, expect, test } from 'bun:test';

import { detectGrid, resolveGrid, solveIntegerUpscale } from '../src/images/grid.ts';

describe('detectGrid (stub)', () => {
  test('reports no grid, which is the conservative answer', () => {
    const raw = { data: new Uint8Array(100 * 100), width: 100, height: 100 };
    expect(detectGrid(raw)).toEqual({ source: 'none' });
  });
});

describe('solveIntegerUpscale', () => {
  test('leaves an already-whole grid size alone', () => {
    expect(solveIntegerUpscale(70, 1400, 980)).toEqual({ factor: 1, gridSize: 70, estimated: false });
  });

  test('scales up to the next whole number when that is within the cap', () => {
    // 71.4 → 72 is a 1.0084× enlargement.
    const solution = solveIntegerUpscale(71.4, 1000, 800, { maxUpscale: 2, maxPixels: 1e9 });
    expect(solution.gridSize).toBe(72);
    expect(solution.estimated).toBe(false);
    expect(solution.factor).toBeCloseTo(72 / 71.4, 6);
  });

  test('the scaled grid size really is a whole number', () => {
    for (const size of [71.4, 88.3, 45.7, 63.25, 99.99]) {
      const solution = solveIntegerUpscale(size, 1000, 1000, { maxUpscale: 2, maxPixels: 1e9 });
      expect(Number.isInteger(solution.gridSize)).toBe(true);
      if (!solution.estimated) {
        expect(size * solution.factor).toBeCloseTo(solution.gridSize, 6);
      }
    }
  });

  test('falls back to rounding when no factor fits under the cap', () => {
    // A cap of 1.001 admits nothing: reaching 72 from 71.4 needs 1.0084×.
    const solution = solveIntegerUpscale(71.4, 1000, 800, { maxUpscale: 1.001, maxPixels: 1e9 });
    expect(solution).toEqual({ factor: 1, gridSize: 71, estimated: true });
  });

  test('falls back to rounding when the result would exceed the pixel ceiling', () => {
    const solution = solveIntegerUpscale(71.4, 10_000, 10_000, { maxUpscale: 2, maxPixels: 1000 });
    expect(solution.estimated).toBe(true);
    expect(solution.factor).toBe(1);
  });

  test('never scales down', () => {
    for (const size of [10.2, 33.6, 128.9]) {
      expect(solveIntegerUpscale(size, 500, 500).factor).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('resolveGrid', () => {
  const image = { width: 1400, height: 980 };

  test('derives the square counts from a supplied grid size', () => {
    expect(resolveGrid({ gridSize: 70 }, image)).toEqual({
      gridSize: 70,
      gridWidth: 20,
      gridHeight: 14,
      source: 'user',
      upscaleFactor: 1,
    });
  });

  test('derives the grid size from a supplied square count', () => {
    expect(resolveGrid({ gridWidth: 20 }, image)).toEqual({
      gridSize: 70,
      gridWidth: 20,
      gridHeight: 14,
      source: 'user',
      upscaleFactor: 1,
    });
  });

  test('derives from the vertical count when only that is given', () => {
    const resolved = resolveGrid({ gridHeight: 14 }, image);
    expect(resolved.gridSize).toBe(70);
    expect(resolved.gridWidth).toBe(20);
  });

  test('never overrides a value the admin typed', () => {
    // 99 is not what the arithmetic would produce, and must survive anyway.
    const resolved = resolveGrid({ gridSize: 70, gridWidth: 99, gridHeight: 3 }, image);
    expect(resolved).toMatchObject({ gridSize: 70, gridWidth: 99, gridHeight: 3, source: 'user' });
  });

  test('rounds a derived size that does not divide evenly', () => {
    // 1400 / 33 = 42.42…
    expect(resolveGrid({ gridWidth: 33 }, image).gridSize).toBe(42);
  });

  test('never derives a zero or negative dimension', () => {
    const resolved = resolveGrid({ gridSize: 5000 }, image);
    expect(resolved.gridWidth).toBeGreaterThanOrEqual(1);
    expect(resolved.gridHeight).toBeGreaterThanOrEqual(1);
  });

  test('with nothing supplied and detection unavailable, records no grid', () => {
    expect(resolveGrid({}, image)).toEqual({
      gridSize: null,
      gridWidth: null,
      gridHeight: null,
      source: 'none',
      upscaleFactor: 1,
    });
  });

  test('with nothing supplied, the stub detector still yields no grid', () => {
    const raw = { data: new Uint8Array(image.width * image.height), ...image };
    expect(resolveGrid({}, image, raw).source).toBe('none');
  });
});
