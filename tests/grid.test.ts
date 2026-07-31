/**
 * Grid geometry.
 *
 * Automatic detection is deferred, so these cover the parts that exist: the
 * capped integer-upscale solver, and the arithmetic that fills in whichever
 * values the admin did not type. Detector tests arrive with the detector.
 */
import { describe, expect, test } from 'bun:test';

import { detectGrid, fitGridToCounts, resolveGrid, solveIntegerUpscale } from '../src/images/grid.ts';
import { isAppError } from '../src/errors.ts';

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

describe('fitGridToCounts', () => {
  test('enlarges the image so the counted squares land on whole pixels', () => {
    // 1000 / 30 = 33.33…, so 34px squares and a 1020px image.
    const fit = fitGridToCounts({ gridWidth: 30, gridHeight: 30 }, { width: 1000, height: 1000 });

    expect(fit.gridSize).toBe(34);
    expect(fit.target).toEqual({ width: 1020, height: 1020 });
    expect(fit.upscaleFactor).toBeCloseTo(1.02, 6);
    expect(fit.capped).toBe(false);
  });

  test('asks for no resize when the counts already divide the image', () => {
    const fit = fitGridToCounts({ gridWidth: 20, gridHeight: 14 }, { width: 1400, height: 980 });
    expect(fit).toEqual({ gridSize: 70, gridWidth: 20, gridHeight: 14, target: null, upscaleFactor: 1, capped: false });
  });

  test('the enlarged image is an exact number of squares on both axes', () => {
    for (const counts of [
      { gridWidth: 30, gridHeight: 21 },
      { gridWidth: 17, gridHeight: 12 },
      { gridWidth: 44, gridHeight: 31 },
    ]) {
      const fit = fitGridToCounts(counts, { width: 1400, height: 980 });
      const size = fit.target ?? { width: 1400, height: 980 };
      expect(size.width / fit.gridSize).toBe(counts.gridWidth);
      expect(size.height / fit.gridSize).toBe(counts.gridHeight);
    }
  });

  test('only scales up, so no part of the map is thrown away', () => {
    for (const width of [999, 1000, 1001, 1010]) {
      const fit = fitGridToCounts({ gridWidth: 30, gridHeight: 21 }, { width, height: 700 });
      expect(fit.upscaleFactor).toBeGreaterThanOrEqual(1);
      expect(fit.target?.width ?? width).toBeGreaterThanOrEqual(width);
    }
  });

  test('rejects counts that disagree about how big a square is', () => {
    // 30 across 1000px is 33.3px; 30 down 800px is 26.7px.
    let thrown: unknown;
    try {
      fitGridToCounts({ gridWidth: 30, gridHeight: 30 }, { width: 1000, height: 800 });
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    const error = thrown as { status: number; fields?: Record<string, string> };
    expect(error.status).toBe(400);
    expect(Object.keys(error.fields ?? {})).toEqual(['gridWidth', 'gridHeight']);
    expect(error.fields?.['gridWidth']).toContain('33.3');
    expect(error.fields?.['gridWidth']).toContain('26.7');
  });

  test('tolerates the small disagreement that rounding to whole squares causes', () => {
    // 27 across 1920px is 71.1px; 15 down 1080px is 72px — near enough.
    const fit = fitGridToCounts({ gridWidth: 27, gridHeight: 15 }, { width: 1920, height: 1080 });
    expect(fit.gridSize).toBe(72);
    expect(fit.target).toEqual({ width: 1944, height: 1080 });
  });

  test('with one count given, only that axis is made exact', () => {
    const fit = fitGridToCounts({ gridWidth: 30 }, { width: 1000, height: 700 });

    expect(fit.gridSize).toBe(34);
    expect(fit.target).toEqual({ width: 1020, height: Math.round(700 * 1.02) });
    expect(fit.gridHeight).toBe(21); // 714 / 34
  });

  test('leaves the file alone when the enlargement would breach the caps', () => {
    const fit = fitGridToCounts({ gridWidth: 30, gridHeight: 30 }, { width: 1000, height: 1000 }, {
      maxUpscale: 1.001,
    });

    expect(fit).toMatchObject({ gridSize: 33, gridWidth: 30, gridHeight: 30, target: null, capped: true });
    expect(fit.upscaleFactor).toBe(1);
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
      target: null,
      capped: false,
    });
  });

  test('derives the grid size from a supplied square count', () => {
    expect(resolveGrid({ gridWidth: 20 }, image)).toEqual({
      gridSize: 70,
      gridWidth: 20,
      gridHeight: 14,
      source: 'user',
      upscaleFactor: 1,
      target: null,
      capped: false,
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

  test('asks for an enlargement when a derived size does not divide evenly', () => {
    // 1400 / 33 = 42.42…, so 43px squares across a 1419px image.
    const resolved = resolveGrid({ gridWidth: 33 }, image);
    expect(resolved.gridSize).toBe(43);
    expect(resolved.target?.width).toBe(1419);
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
      target: null,
      capped: false,
    });
  });

  test('with nothing supplied, the stub detector still yields no grid', () => {
    const raw = { data: new Uint8Array(image.width * image.height), ...image };
    expect(resolveGrid({}, image, raw).source).toBe('none');
  });
});
