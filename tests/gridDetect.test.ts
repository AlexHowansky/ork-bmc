/**
 * The signal processing behind grid detection.
 *
 * These work on planes built in memory rather than on encoded images, so a
 * failure points at the arithmetic and not at sharp. `grid.test.ts` covers what
 * `detectGrid` makes of a measurement; the end of the path — an upload that has
 * its grid measured — is in `images.test.ts` and `http.test.ts`.
 */
import { describe, expect, test } from 'bun:test';

import { detrend, edgeEnergy, measureAxis } from '../src/images/gridDetect.ts';
import { paintGridPlane } from './helpers.ts';

/** The shipped defaults, written out so the suite does not move with the env. */
const bounds = { minPx: 16, maxPx: 512, minConfidence: 2.5 };

describe('edgeEnergy', () => {
  test('finds a line where it was painted, and nothing where it was not', () => {
    // One vertical line at x = 10 on an otherwise flat field.
    const width = 40;
    const height = 20;
    const data = new Uint8Array(width * height).fill(200);
    for (let y = 0; y < height; y++) data[y * width + 10] = 50;

    const columns = edgeEnergy({ data, width, height }, 'columns');

    // A central difference straddles the line: it reads the pixels either side
    // of x, which at x = 10 are both background.
    expect(columns[9]).toBe(150 * height);
    expect(columns[10]).toBe(0);
    expect(columns[11]).toBe(150 * height);
    expect(columns[12]).toBe(0);
    expect(columns[20]).toBe(0);

    // A vertical line says nothing about the spacing of horizontal ones.
    expect(Array.from(edgeEnergy({ data, width, height }, 'rows')).every((value) => value === 0)).toBe(true);
  });

  test('leaves the outermost sample of each projection at zero', () => {
    const plane = paintGridPlane(60, 40, 20);
    const columns = edgeEnergy(plane, 'columns');
    const rows = edgeEnergy(plane, 'rows');

    expect(columns).toHaveLength(60);
    expect(rows).toHaveLength(40);
    expect(columns[0]).toBe(0);
    expect(columns[59]).toBe(0);
    expect(rows[0]).toBe(0);
    expect(rows[39]).toBe(0);
  });

  test('refuses a buffer that is not the plane it claims to be', () => {
    expect(() => edgeEnergy({ data: new Uint8Array(10), width: 40, height: 40 }, 'columns')).toThrow(/single-channel/);
  });
});

describe('detrend', () => {
  test('levels a constant projection to nothing', () => {
    const levelled = detrend(new Float64Array(50).fill(7), 11);
    expect(Array.from(levelled).every((value) => value === 0)).toBe(true);
  });

  test('keeps a spike and discards the slope it sits on', () => {
    const energy = new Float64Array(101);
    for (let i = 0; i < energy.length; i++) energy[i] = i;
    energy[50] = 50 + 400;

    const levelled = detrend(energy, 21);

    expect(levelled[50]).toBeGreaterThan(300);
    // Everything else is exactly as far above its neighbours as the ramp
    // demands, which is not at all — bar the shoulders the spike itself lifts.
    expect(levelled[20]).toBe(0);
    expect(levelled[80]).toBe(0);
  });
});

describe('measureAxis', () => {
  const measure = (plane: ReturnType<typeof paintGridPlane>) => measureAxis(edgeEnergy(plane, 'columns'), bounds);

  test('recovers the spacing it was painted with', () => {
    for (const period of [20, 37, 50, 64, 70, 128]) {
      const measured = measure(paintGridPlane(1000, 400, period));
      expect(measured).not.toBeNull();
      expect(measured!.period).toBeCloseTo(period, 1);
    }
  });

  test('answers with the grid, not with its octave', () => {
    // Every tooth of a 128px comb lands on a line of a 64px grid, so the two
    // score alike and only the lines between them tell the pair apart.
    const measured = measure(paintGridPlane(1000, 400, 64));
    expect(measured!.period).toBeCloseTo(64, 1);
  });

  test('finds a grid that does not start at the edge', () => {
    const measured = measure(paintGridPlane(1000, 400, 70, { phase: 23 }));
    expect(measured!.period).toBeCloseTo(70, 1);
    expect(measured!.phase).toBeCloseTo(23, 1);
  });

  test('measures a spacing that falls between pixels', () => {
    const measured = measure(paintGridPlane(1000, 400, 70.4));
    expect(measured!.period).toBeCloseTo(70.4, 1);
  });

  test('sees through faint lines, thick lines, and noise', () => {
    expect(measure(paintGridPlane(1000, 400, 50, { contrast: 15 }))!.period).toBeCloseTo(50, 1);
    expect(measure(paintGridPlane(1000, 400, 50, { lineWidth: 3, contrast: 50 }))!.period).toBeCloseTo(50, 1);
    expect(measure(paintGridPlane(1000, 400, 50, { noise: 40 }))!.period).toBeCloseTo(50, 1);
  });

  test('reports how many lines the measurement rests on', () => {
    // 1000px at 50px apart is 20 lines, but a comb that settles a hair before
    // the first of them starts on the second, and 19 is the same answer.
    const wide = measure(paintGridPlane(1000, 400, 50))!;
    expect(wide.teeth).toBeGreaterThanOrEqual(19);
    expect(wide.teeth).toBeLessThanOrEqual(20);

    // Four is the fewest lines a period is allowed to be measured across, and
    // it is what a 280px plane at 70px apart has.
    expect(measure(paintGridPlane(280, 200, 70))!.teeth).toBe(4);
  });

  test('finds nothing in a picture with no grid on it', () => {
    expect(measure(paintGridPlane(1000, 400, null))).toBeNull();
  });

  test('ignores a spacing finer than the floor it was given', () => {
    // Eight pixels is texture, not a grid, and GRID_MIN_PX says so.
    expect(measure(paintGridPlane(1000, 400, 8))).toBeNull();
  });

  test('ignores a spacing too coarse to have been counted', () => {
    // Three lines across the image is not a pattern, whatever GRID_MAX_PX says.
    expect(measure(paintGridPlane(1000, 400, 400))).toBeNull();
  });

  test('holds out for the confidence it was asked for', () => {
    const plane = paintGridPlane(1000, 400, 50, { contrast: 15 });
    expect(measureAxis(edgeEnergy(plane, 'columns'), { ...bounds, minConfidence: 1000 })).toBeNull();
  });
});
