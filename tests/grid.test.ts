/**
 * Grid geometry: the capped integer-upscale solver, the arithmetic that fills in
 * whichever values the admin did not type, and what `detectGrid` makes of a
 * measurement. The measuring itself is in `gridDetect.test.ts`.
 */
import { describe, expect, test } from 'bun:test';

import {
  detectGrid,
  fitGridToCounts,
  gridFromFilename,
  resolveGrid,
  solveIntegerUpscale,
} from '../src/images/grid.ts';
import { isAppError } from '../src/errors.ts';
import { paintGridPlane } from './helpers.ts';

describe('detectGrid', () => {
  test('measures a grid both axes agree on', () => {
    expect(detectGrid(paintGridPlane(1000, 800, 50))).toEqual({
      gridSize: 50,
      gridWidth: 20,
      gridHeight: 16,
      source: 'detected',
      upscaleFactor: 1,
    });
  });

  test('reports no grid, which is the conservative answer', () => {
    expect(detectGrid({ data: new Uint8Array(100 * 100), width: 100, height: 100 })).toEqual({ source: 'none' });
    expect(detectGrid(paintGridPlane(1000, 800, null))).toEqual({ source: 'none' });
  });

  test('answers in the coordinates of the image, not of the plane measured', () => {
    // Half-size plane, so every period measured on it is half what the image has.
    const result = detectGrid(paintGridPlane(500, 400, 25), { width: 1000, height: 800 });
    expect(result).toMatchObject({ gridSize: 50, gridWidth: 20, gridHeight: 16, source: 'detected' });
  });

  test('asks for the enlargement that makes a measured square whole', () => {
    // 70.4px squares cannot be stored as they are; 71px can, for 0.9% more image.
    const result = detectGrid(paintGridPlane(1000, 800, 70.4));
    expect(result).toMatchObject({ gridSize: 71, source: 'detected' });
    expect('upscaleFactor' in result && result.upscaleFactor).toBeCloseTo(71 / 70.4, 2);
  });

  test('does not ask for an enlargement on the strength of a rounding error', () => {
    // Measuring is not exact, and a square that comes back 50.005px across is a
    // 50px square — not grounds for growing the file by two per cent.
    expect(detectGrid(paintGridPlane(1000, 800, 50))).toMatchObject({ gridSize: 50, upscaleFactor: 1 });
  });

  test('declines when the two axes contradict each other', () => {
    // Squares are square, so 40 across and 60 down cannot both be right.
    expect(detectGrid(paintGridPlane(1000, 800, 40, { periodY: 60 }))).toEqual({ source: 'none' });
  });

  test('offers a single measurable axis for checking rather than as fact', () => {
    // Horizontal lines only: the spacing is real, but nothing corroborates it.
    const result = detectGrid(paintGridPlane(1000, 800, null, { periodY: 50 }));
    expect(result).toMatchObject({ gridSize: 50, source: 'estimated' });
  });

  test('never enlarges the image on the word of one axis', () => {
    // 47.5px squares would divide 1000px exactly at 48, and a corroborated
    // reading would ask for that. One axis is not enough to grow the file over.
    const result = detectGrid(paintGridPlane(1000, 800, null, { periodY: 47.5 }));
    expect(result).toMatchObject({ gridSize: 48, source: 'estimated', upscaleFactor: 1 });
  });

  test('declines a spacing that would leave too few squares to be a grid', () => {
    // 400px squares on a plane 120px wide is not a grid, it is a stripe.
    expect(detectGrid(paintGridPlane(120, 2000, null, { periodY: 400 }))).toEqual({ source: 'none' });
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

  test('with nothing supplied, a plane with no grid on it yields no grid', () => {
    expect(resolveGrid({}, image, paintGridPlane(image.width, image.height, null)).source).toBe('none');
  });

  test('with nothing supplied, a plane with a grid on it is measured', () => {
    const raw = paintGridPlane(image.width, image.height, 50);
    expect(resolveGrid({}, image, raw)).toMatchObject({ gridSize: 50, source: 'detected', target: null });
  });

  test('a grid the admin typed is never displaced by one that could be measured', () => {
    const raw = paintGridPlane(image.width, image.height, 50);
    expect(resolveGrid({ gridSize: 70 }, image, raw)).toMatchObject({ gridSize: 70, source: 'user' });
  });
});

describe('gridFromFilename', () => {
  const grid = (width: number, height: number) => ({ gridWidth: width, gridHeight: height });

  test('reads the counts out of a plainly named file', () => {
    expect(gridFromFilename('Forest Road 40x30.png')).toEqual(grid(40, 30));
  });

  test('accepts the separators and spacing people actually type', () => {
    expect(gridFromFilename('Forest Road 40X30.png')).toEqual(grid(40, 30));
    expect(gridFromFilename('Forest Road 40 x 30.webp')).toEqual(grid(40, 30));
    expect(gridFromFilename('Forest Road 40×30.jpg')).toEqual(grid(40, 30));
    expect(gridFromFilename('forest_road_40x30.png')).toEqual(grid(40, 30));
    expect(gridFromFilename('Forest Road (40x30).png')).toEqual(grid(40, 30));
    expect(gridFromFilename('Forest Road [40x30].png')).toEqual(grid(40, 30));
  });

  test('ignores a path in front of the name', () => {
    expect(gridFromFilename('/home/alex/maps/Forest Road 40x30.png')).toEqual(grid(40, 30));
    expect(gridFromFilename('C:\\maps\\Forest Road 40x30.png')).toEqual(grid(40, 30));
  });

  test('refuses pixel dimensions, which is what most filenames carry', () => {
    // The whole reason for an upper bound: this is a resolution, not a grid.
    expect(gridFromFilename('Riverbank 1920x1080.png')).toBeNull();
    expect(gridFromFilename('Keep 4096x4096.webp')).toBeNull();
  });

  test('refuses counts too small to be a grid', () => {
    expect(gridFromFilename('Ruins v2x2.png')).toBeNull();
    expect(gridFromFilename('Tokens 1x1.png')).toBeNull();
  });

  test('does not tear a number out of a longer one', () => {
    expect(gridFromFilename('Cavern 1140x30.png')).toBeNull();
    expect(gridFromFilename('Cavern 40x3000.png')).toBeNull();
    expect(gridFromFilename('Scale 1.5x30.png')).toBeNull();
  });

  test('finds nothing to read in an ordinary name', () => {
    expect(gridFromFilename('River Crossing.png')).toBeNull();
    expect(gridFromFilename('map.png')).toBeNull();
    expect(gridFromFilename('')).toBeNull();
  });

  test('does not read the extension', () => {
    expect(gridFromFilename('sunken-temple.40x30')).toBeNull();
  });
});
