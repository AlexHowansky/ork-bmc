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

export interface ResolvedGrid {
  gridSize: number | null;
  gridWidth: number | null;
  gridHeight: number | null;
  source: GridSource;
  upscaleFactor: number;
}

/**
 * Works out the grid geometry to store, combining what the admin typed with
 * what can be derived and — once implemented — what can be detected.
 *
 * Anything the admin supplied is authoritative and is never second-guessed.
 * Missing values are filled by arithmetic where the supplied ones allow it,
 * because a grid size and an image width already determine the column count.
 * Detection is consulted only when there is nothing to derive from.
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
    };
  }

  if (gridWidth !== undefined || gridHeight !== undefined) {
    // A square count on either axis implies the pixel size of a square.
    const derivedSize =
      gridWidth !== undefined ? image.width / gridWidth : image.height / gridHeight!;
    const size = Math.max(1, Math.round(derivedSize));

    return {
      gridSize: size,
      gridWidth: gridWidth ?? Math.max(1, Math.round(image.width / size)),
      gridHeight: gridHeight ?? Math.max(1, Math.round(image.height / size)),
      source: 'user',
      upscaleFactor: 1,
    };
  }

  // Nothing supplied: this is where detection would contribute.
  const detected = raw ? detectGrid(raw) : ({ source: 'none' } as const);

  if (detected.source === 'none') {
    return { gridSize: null, gridWidth: null, gridHeight: null, source: 'none', upscaleFactor: 1 };
  }

  return {
    gridSize: detected.gridSize,
    gridWidth: detected.gridWidth,
    gridHeight: detected.gridHeight,
    source: detected.source,
    upscaleFactor: detected.upscaleFactor,
  };
}
