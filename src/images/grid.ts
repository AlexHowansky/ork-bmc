/**
 * Grid geometry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTOMATIC DETECTION IS NOT IMPLEMENTED YET.
 *
 * `detectGrid` is a stub that reports "no grid found". Everything around it is
 * finished and exercised: the upload path calls it, handles every branch of
 * `GridResult`, persists `grid_source` / `upscale_factor`, and the UI renders
 * the resulting states. Replacing the stub is a change to this one function —
 * no caller needs to move.
 *
 * The intended approach, for whoever picks this up:
 *   1. Build per-column and per-row edge-energy projections from the greyscale
 *      buffer: colEnergy[x] = Σ_y |L(x+1,y) − L(x−1,y)|. Grid lines show up as
 *      periodic spikes.
 *   2. Detrend by subtracting a moving average, clamping negatives to zero, so
 *      broad luminance variation does not swamp the signal.
 *   3. Score candidate periods with a comb filter: for a real period p and
 *      phase φ, sum the interpolated energy at x = φ + k·p, normalised. Scan
 *      integer p over [GRID_MIN_PX, GRID_MAX_PX], then refine p and φ
 *      continuously for sub-pixel accuracy.
 *   4. Confidence = peak score ÷ median score, against GRID_MIN_CONFIDENCE.
 *   5. Reconcile the two axes — squares are square — then hand the result to
 *      `solveIntegerUpscale` below, which is already written and tested.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { config } from '../config.ts';
import { validationFailed } from '../errors.ts';

/** How the stored grid values were arrived at. */
export type GridSource = 'none' | 'user' | 'detected' | 'estimated';

export interface GridGeometry {
  gridSize: number;
  gridWidth: number;
  gridHeight: number;
}

export type GridResult =
  | (GridGeometry & { source: 'detected' | 'estimated'; upscaleFactor: number })
  | { source: 'none' };

export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Looks for a painted grid in a greyscale image.
 *
 * STUB: always reports no grid. See the module comment for the intended
 * implementation. Returning 'none' is the correct conservative answer — the
 * admin is asked to fill the values in by hand.
 */
export function detectGrid(_raw: RawImage): GridResult {
  return { source: 'none' };
}

export interface UpscaleSolution {
  /** Scale factor to apply to the image; 1 means leave it alone. */
  factor: number;
  /** The whole-number grid size that results. */
  gridSize: number;
  /** True when the factor was capped and the grid size was rounded instead. */
  estimated: boolean;
}

/**
 * Finds the smallest upscale that turns a fractional grid size into a whole
 * number, subject to the configured cap and a ceiling on output pixels.
 *
 * Enlarging by whatever factor the arithmetic demands can be extreme — a
 * 71.4px grid taken to 72px is a gentle 1.008×, but to reach the next integer
 * from 71.6 might not be. The caps keep a plausible detection from producing an
 * implausible file. When nothing fits, the grid size is rounded and the caller
 * is told the value is an estimate rather than a measurement.
 */
export function solveIntegerUpscale(
  gridSize: number,
  imageWidth: number,
  imageHeight: number,
  options: { maxUpscale?: number; maxPixels?: number } = {},
): UpscaleSolution {
  const maxUpscale = options.maxUpscale ?? config.grid.maxUpscale;
  const maxPixels = options.maxPixels ?? config.maxImagePixels;

  const rounded = Math.max(1, Math.round(gridSize));

  // Already whole (within floating-point noise): nothing to do.
  if (Math.abs(gridSize - Math.round(gridSize)) < 1e-6) {
    return { factor: 1, gridSize: rounded, estimated: false };
  }

  // Candidate whole grid sizes, smallest factor first. Scaling up only, so the
  // search starts at the next integer above the measured size.
  const highest = Math.floor(gridSize * maxUpscale);
  for (let target = Math.ceil(gridSize); target <= highest; target++) {
    const factor = target / gridSize;
    if (factor > maxUpscale) break;
    if (Math.round(imageWidth * factor) * Math.round(imageHeight * factor) > maxPixels) continue;
    return { factor, gridSize: target, estimated: false };
  }

  return { factor: 1, gridSize: rounded, estimated: true };
}

export interface GridInput {
  gridSize?: number | undefined;
  gridWidth?: number | undefined;
  gridHeight?: number | undefined;
}

// ---------------------------------------------------------------------------
// Square counts written into a filename
// ---------------------------------------------------------------------------

/**
 * The smallest and largest square counts worth believing from a filename.
 *
 * The upper bound is what keeps `Riverbank 1920x1080.png` from being read as a
 * grid: map filenames carry pixel dimensions at least as often as square counts,
 * and nobody paints a grid two thousand squares across. A 200-square map at a
 * typical 70px per square is already 14,000 pixels wide, past what WEBP can
 * store. The lower bound rules out `Ruins v2x2.png` and similar noise.
 */
const MIN_FILENAME_SQUARES = 3;
const MAX_FILENAME_SQUARES = 200;

/**
 * Matches the square counts in a name like `Forest Road 40x30`.
 *
 * Anchored on non-digit boundaries so `1140x30` is not read as `40x30`, and the
 * separator covers what people actually type: `x`, `X`, and the `×` sign a Mac
 * will happily insert. Any brackets around it are left to the caller to tidy.
 *
 * The leading boundary is a captured group rather than a lookbehind, because
 * `public/app.js` carries a copy of this and a lookbehind is a *parse* error in
 * Safari before 16.4 — which would take the whole script down, not just this
 * feature. Anything replacing the match must put `$1` back.
 */
export const FILENAME_GRID_PATTERN = /(^|[^\d.])(\d{1,4})\s*[xX×]\s*(\d{1,4})(?![\d.])/;

/**
 * Reads square counts out of a filename, for use as form defaults.
 *
 * Deliberately conservative: it is offering the admin a starting point on the
 * upload form, not recording a measurement, so anything ambiguous returns null
 * and the fields stay blank. `public/app.js` carries an ES5 copy of this so the
 * fields fill in as soon as a file is chosen; this is the authority.
 */
export function gridFromFilename(filename: string): { gridWidth: number; gridHeight: number } | null {
  const base = filename.split(/[\\/]/).pop() ?? '';
  // Drop the extension first, so `map.40x30` cannot be read out of `.40x30`
  // and, more usefully, so nothing in the extension can match.
  const stem = base.replace(/\.[^.]+$/, '') || base;

  const match = FILENAME_GRID_PATTERN.exec(stem);
  if (!match?.[2] || !match[3]) return null;

  const gridWidth = Number(match[2]);
  const gridHeight = Number(match[3]);

  const plausible = (count: number): boolean =>
    Number.isInteger(count) && count >= MIN_FILENAME_SQUARES && count <= MAX_FILENAME_SQUARES;

  return plausible(gridWidth) && plausible(gridHeight) ? { gridWidth, gridHeight } : null;
}

/** Dimensions an image must have for its recorded grid to land on whole pixels. */
export interface TargetSize {
  width: number;
  height: number;
}

export interface GridFit extends GridGeometry {
  /** What the image must be resized to; null when it already fits. */
  target: TargetSize | null;
  /** Scale of `target` against the image it was measured from; 1 when there is no target. */
  upscaleFactor: number;
  /** True when the caps blocked the upscale and the grid size was rounded instead. */
  capped: boolean;
}

/**
 * The most the two axes may disagree about the size of a square before the
 * counts are rejected as describing a grid that is not square.
 *
 * A little slack is needed because a whole number of squares rarely divides a
 * photographed map exactly, and because only one of the two counts may have been
 * measured carefully. Beyond it the two numbers are describing different grids,
 * and the honest answer is to say so rather than to stretch the map.
 */
const SIZE_AGREEMENT_PX = 1;
const SIZE_AGREEMENT_RATIO = 0.01;

const roundTo = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/**
 * Works out the grid an admin described by counting squares, and the image size
 * that would make it exact.
 *
 * Typing "30 squares across" on a 1000px map is a statement that each square is
 * 33.33px, which no image can represent. Rounding to 33 leaves the recorded grid
 * describing something the file is not — the overlay drifts a pixel per column.
 * Instead the square size is taken up to the next whole number and the image is
 * enlarged to suit: 34px squares, 30 of them, so 1020px across.
 *
 * Throws a field error when the two counts disagree about how big a square is,
 * because the only way to satisfy both would be to stretch one axis.
 */
export function fitGridToCounts(
  counts: { gridWidth?: number | undefined; gridHeight?: number | undefined },
  image: { width: number; height: number },
  options: { maxUpscale?: number; maxPixels?: number } = {},
): GridFit {
  const { gridWidth, gridHeight } = counts;

  const sizeFromWidth = gridWidth !== undefined ? image.width / gridWidth : undefined;
  const sizeFromHeight = gridHeight !== undefined ? image.height / gridHeight : undefined;

  if (sizeFromWidth === undefined && sizeFromHeight === undefined) {
    throw new Error('fitGridToCounts needs at least one of gridWidth or gridHeight');
  }

  if (sizeFromWidth !== undefined && sizeFromHeight !== undefined) {
    const larger = Math.max(sizeFromWidth, sizeFromHeight);
    const tolerance = Math.max(SIZE_AGREEMENT_PX, larger * SIZE_AGREEMENT_RATIO);

    if (Math.abs(sizeFromWidth - sizeFromHeight) > tolerance) {
      const message =
        `${gridWidth} squares across a ${image.width}px image is ${roundTo(sizeFromWidth, 1)}px per square, ` +
        `but ${gridHeight} down a ${image.height}px image is ${roundTo(sizeFromHeight, 1)}px. ` +
        `Squares are square, so please check these two values.`;
      throw validationFailed({ gridWidth: message, gridHeight: message });
    }
  }

  // Take the larger implied size so that neither axis has to be shrunk to fit.
  const measured = Math.max(sizeFromWidth ?? 0, sizeFromHeight ?? 0);
  const solved = solveIntegerUpscale(measured, image.width, image.height, options);
  const gridSize = solved.gridSize;

  // The counts the admin gave are kept as typed; anything missing follows from
  // the square size, exactly as it does when a size is entered directly.
  const width = gridWidth ?? Math.max(1, Math.round((image.width * solved.factor) / gridSize));
  const height = gridHeight ?? Math.max(1, Math.round((image.height * solved.factor) / gridSize));

  if (solved.estimated) {
    // The caps refused the enlargement, so the size is rounded instead and the
    // file is left as it is.
    return { gridSize, gridWidth: width, gridHeight: height, target: null, upscaleFactor: 1, capped: true };
  }

  // An axis the admin counted lands on an exact multiple of the square size.
  // The other one is only scaled, because snapping a count that was derived by
  // rounding could stretch the map by half a square. Neither can come out
  // smaller: the square size is at least what each axis implied.
  const target: TargetSize = {
    width: gridWidth !== undefined ? gridWidth * gridSize : Math.round(image.width * solved.factor),
    height: gridHeight !== undefined ? gridHeight * gridSize : Math.round(image.height * solved.factor),
  };

  // The square size can already be whole while one axis still does not divide
  // by it — 1920×1080 counted as 27×15 gives 72px squares, but only 26.67 of
  // them across — so the dimensions decide this, not the factor.
  if (target.width === image.width && target.height === image.height) {
    return { gridSize, gridWidth: width, gridHeight: height, target: null, upscaleFactor: 1, capped: false };
  }

  return {
    gridSize,
    gridWidth: width,
    gridHeight: height,
    target,
    upscaleFactor: target.width / image.width,
    capped: false,
  };
}

export interface ResolvedGrid {
  gridSize: number | null;
  gridWidth: number | null;
  gridHeight: number | null;
  source: GridSource;
  upscaleFactor: number;
  /** Set when the image must be resized for the grid above to be exact. */
  target: TargetSize | null;
  /** True when an enlargement was called for but the caps refused it. */
  capped: boolean;
}

/**
 * Works out the grid geometry to store, combining what the admin typed with
 * what can be derived and — once implemented — what can be detected.
 *
 * Anything the admin supplied is authoritative and is never second-guessed.
 * Missing values are filled by arithmetic where the supplied ones allow it,
 * because a grid size and an image width already determine the column count.
 * A square count goes through `fitGridToCounts`, which can ask for the image to
 * be enlarged so the count divides it exactly. Detection is consulted only when
 * there is nothing to derive from.
 */
export function resolveGrid(input: GridInput, image: { width: number; height: number }, raw?: RawImage): ResolvedGrid {
  const { gridSize, gridWidth, gridHeight } = input;

  if (gridSize !== undefined) {
    return {
      gridSize,
      gridWidth: gridWidth ?? Math.max(1, Math.round(image.width / gridSize)),
      gridHeight: gridHeight ?? Math.max(1, Math.round(image.height / gridSize)),
      source: 'user',
      upscaleFactor: 1,
      target: null,
      capped: false,
    };
  }

  if (gridWidth !== undefined || gridHeight !== undefined) {
    const fit = fitGridToCounts({ gridWidth, gridHeight }, image);

    return {
      gridSize: fit.gridSize,
      gridWidth: fit.gridWidth,
      gridHeight: fit.gridHeight,
      source: 'user',
      upscaleFactor: fit.upscaleFactor,
      target: fit.target,
      capped: fit.capped,
    };
  }

  // Nothing supplied: this is where detection would contribute.
  const detected = raw ? detectGrid(raw) : ({ source: 'none' } as const);

  if (detected.source === 'none') {
    return {
      gridSize: null,
      gridWidth: null,
      gridHeight: null,
      source: 'none',
      upscaleFactor: 1,
      target: null,
      capped: false,
    };
  }

  return {
    gridSize: detected.gridSize,
    gridWidth: detected.gridWidth,
    gridHeight: detected.gridHeight,
    source: detected.source,
    upscaleFactor: detected.upscaleFactor,
    target:
      detected.upscaleFactor > 1
        ? {
            width: Math.round(image.width * detected.upscaleFactor),
            height: Math.round(image.height * detected.upscaleFactor),
          }
        : null,
    capped: false,
  };
}
