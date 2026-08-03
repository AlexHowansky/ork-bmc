/**
 * Finding the period of a painted grid.
 *
 * A battle map's grid is the one thing on it that repeats: whatever else the
 * artist drew, the lines march across the image at a fixed spacing. That turns
 * "how big is a square?" into a signal-processing question, and one that can be
 * answered on two one-dimensional projections rather than the whole picture.
 *
 *   1. `edgeEnergy` collapses the image onto an axis by summing the absolute
 *      horizontal (or vertical) gradient. A vertical grid line contributes to
 *      every row it crosses, so it stands up as a spike; a tree or a doorway
 *      contributes to a handful of rows and does not.
 *   2. `measureAxis` detrends that projection, then scores candidate periods
 *      with a comb filter — the mean energy under teeth spaced `p` apart — and
 *      reports the best period, its phase, and how far the winner stands above
 *      the field.
 *
 * Everything here is pure arithmetic over a `RawImage`, the same shape as
 * `perceptualHash`, so it can be tested on a hand-built buffer with no sharp and
 * no files. `detectGrid` in `grid.ts` is what turns a measurement into a grid.
 */
import type { RawImage } from './grid.ts';

/** Nothing shorter than this can be a grid square, whatever GRID_MIN_PX says. */
const MIN_PERIOD = 2;

/**
 * The fewest teeth a candidate period must have before its score means anything.
 *
 * Two or three lines is not a pattern — any smooth image has some pair of
 * columns that happen to be bright together. Four is the point where a spacing
 * has to have been intended.
 */
const MIN_TEETH = 4;

/**
 * How strong the lines a shorter period claims to have found must be.
 *
 * Every tooth of a period `2p` lands on a tooth of `p`, so the two score alike
 * and the scan is as likely to answer with a grid's octave as with the grid —
 * more likely, in fact, because the fewer teeth a comb has the easier it is for
 * all of them to land somewhere strong.
 *
 * The question that separates them is not how the two score overall but whether
 * the lines *between* the octave's teeth exist. Halving a real period finds a
 * line every time, so the new teeth are as strong as the old ones; halving it
 * again finds blank map, and they are not. Anything past the midpoint of those
 * two cases is a real line.
 */
const HARMONIC_SUPPORT = 0.5;

/**
 * How much of a comb has to have found something for it to be a grid.
 *
 * A period twice a real one lands on every other line and on blank map in
 * between, and averages out to a respectable score on the strength of the half
 * that hit. Grids do not have every other line missing. A tooth is allowed to
 * come up short — a line can run under a building, or off the edge of the
 * painted area — but most of them landing on nothing means the spacing is wrong.
 */
const MIN_LIVE_TEETH = 0.75;

/** How weak a tooth may be, against the average of them, and still count. */
const LIVE_TOOTH_SHARE = 0.25;

/**
 * Ceiling on the reported confidence.
 *
 * A synthetic grid on a flat background gives a median score of exactly zero,
 * and a ratio against that is not a number anything downstream can weight with.
 */
const MAX_CONFIDENCE = 1000;

/** Slack for the `<=` at the end of a floating-point step loop. */
const EPSILON = 1e-9;

export interface AxisMeasurement {
  /** Sub-pixel spacing between lines, in the coordinates of the plane measured. */
  period: number;
  /** Offset of the first line, in `[0, period)`. */
  phase: number;
  /** Peak comb score against the median of the field; higher is more certain. */
  confidence: number;
  /** How many lines the period was measured across; fewer means less precision. */
  teeth: number;
}

export interface AxisBounds {
  minPx: number;
  maxPx: number;
  minConfidence: number;
}

/**
 * Collapses a greyscale plane onto one axis as a gradient sum.
 *
 * `colEnergy[x] = Σ_y |L(x+1,y) − L(x−1,y)|`, and the transpose for rows. The
 * outermost column and row of each projection stay at zero, having no
 * neighbours on both sides to difference.
 */
export function edgeEnergy(raw: RawImage, axis: 'columns' | 'rows'): Float64Array {
  const { data, width, height } = raw;
  if (data.length < width * height) {
    throw new Error(`edgeEnergy needs ${width}×${height} single-channel samples, got ${data.length}`);
  }

  if (axis === 'columns') {
    const energy = new Float64Array(width);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        energy[x] = energy[x]! + Math.abs(data[row + x + 1]! - data[row + x - 1]!);
      }
    }
    return energy;
  }

  const energy = new Float64Array(height);
  for (let y = 1; y < height - 1; y++) {
    const above = (y - 1) * width;
    const below = (y + 1) * width;
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += Math.abs(data[below + x]! - data[above + x]!);
    }
    energy[y] = sum;
  }
  return energy;
}

/**
 * Subtracts a moving average and clamps what is left at zero.
 *
 * A map that is dark on one side and bright on the other has more gradient
 * everywhere on the busy side, and without this the comb would rather sit on
 * that half of the image than on the grid. Only the part of each column that
 * exceeds its neighbourhood survives.
 *
 * The window is widened to an odd number so it is symmetric, and clipped at the
 * ends rather than padded — a padded average would invent a trough at each edge
 * and manufacture two spikes there.
 */
export function detrend(energy: Float64Array, window: number): Float64Array {
  const span = Math.max(3, Math.round(window) | 1);
  const half = (span - 1) / 2;
  const n = energy.length;

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i]! + energy[i]!;
  }

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(n, i + half + 1);
    out[i] = Math.max(0, energy[i]! - (prefix[to]! - prefix[from]!) / (to - from));
  }
  return out;
}

/**
 * Merges the pair of spikes a thin line leaves in the projection.
 *
 * `|L(x+1) − L(x−1)|` is zero *at* the centre of a one-pixel line — both
 * neighbours are background — and large one pixel either side of it. The comb
 * would still lock onto the right period, since both spikes repeat at that
 * period, but it would sit in the trough between them and score the grid far
 * lower than it deserves. A three-tap box puts the energy back where the line is.
 */
function smooth(energy: Float64Array): Float64Array {
  const n = energy.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const left = energy[i - 1] ?? 0;
    const right = energy[i + 1] ?? 0;
    out[i] = (left + energy[i]! + right) / 3;
  }
  return out;
}

/** Energy at a fractional position, linearly interpolated; zero outside the plane. */
function sampleAt(energy: Float64Array, position: number): number {
  const n = energy.length;
  if (position < 0 || position > n - 1) return 0;
  const low = Math.floor(position);
  const high = Math.min(n - 1, low + 1);
  const fraction = position - low;
  return energy[low]! * (1 - fraction) + energy[high]! * fraction;
}

/**
 * Mean energy under teeth at `phase + k·period`.
 *
 * A mean rather than a sum, so that a long period is not punished for having
 * fewer teeth than a short one. Too few teeth to judge scores zero.
 */
function combScore(energy: Float64Array, period: number, phase: number): number {
  const last = energy.length - 1;
  let sum = 0;
  let teeth = 0;

  for (let k = 0; ; k++) {
    const position = phase + k * period;
    if (position > last) break;
    sum += sampleAt(energy, position);
    teeth++;
  }

  return teeth >= MIN_TEETH ? sum / teeth : 0;
}

interface CombPeak {
  period: number;
  phase: number;
  score: number;
}

/**
 * Best comb over a rectangle of the (period, phase) search space.
 *
 * With no `phase` window the sweep covers a whole period, which is what the
 * first pass needs; the refinement passes give one and search around it.
 */
function bestComb(
  energy: Float64Array,
  period: { from: number; to: number; step: number },
  phase: { step: number; around?: number; within?: number },
): CombPeak {
  let best: CombPeak = { period: period.from, phase: 0, score: -1 };

  for (let candidate = period.from; candidate <= period.to + EPSILON; candidate += period.step) {
    if (candidate < MIN_PERIOD) continue;

    const from = phase.around !== undefined ? phase.around - phase.within! : 0;
    const to = phase.around !== undefined ? phase.around + phase.within! : candidate - phase.step;

    for (let offset = from; offset <= to + EPSILON; offset += phase.step) {
      // Phases are cyclic: a refinement that walks off either end of the window
      // is asking about the same comb from the other side of it.
      const wrapped = ((offset % candidate) + candidate) % candidate;
      const score = combScore(energy, candidate, wrapped);
      if (score > best.score) {
        best = { period: candidate, phase: wrapped, score };
      }
    }
  }

  return best;
}

/**
 * How strong the lines a comb would gain by dividing its period are, against
 * the ones it already has.
 *
 * Near 1 when every gained tooth lands on a line, which is what dividing a real
 * octave looks like; near 0 when they land on blank map, which is what dividing
 * a real grid looks like.
 */
function subMultipleSupport(energy: Float64Array, period: number, phase: number, divisor: number): number {
  const last = energy.length - 1;
  const candidate = period / divisor;

  let shared = 0;
  let sharedTeeth = 0;
  let gained = 0;
  let gainedTeeth = 0;

  for (let k = 0; ; k++) {
    const position = phase + k * candidate;
    if (position > last) break;
    const value = sampleAt(energy, position);
    if (k % divisor === 0) {
      shared += value;
      sharedTeeth++;
    } else {
      gained += value;
      gainedTeeth++;
    }
  }

  if (sharedTeeth === 0 || gainedTeeth === 0 || shared <= 0) return 0;
  return gained / gainedTeeth / (shared / sharedTeeth);
}

/**
 * Walks a winning period down to the grid it may be an octave of.
 *
 * Divisors are tried from the largest down, so the shortest period that still
 * lands on real lines wins — the fundamental, not one of the harmonics between
 * it and where the scan happened to stop.
 *
 * The walk goes below `minPeriod`, which the scan itself would not, and answers
 * null if that is where the fundamental turns out to be. Cross-hatching, a
 * dithered texture, the weave of a photographed battle mat: all of them repeat
 * finer than any grid, and every multiple of them is a comb that lands on
 * something. Declining is the only honest answer, because the spacing the caller
 * would otherwise be given is an arbitrary one of those multiples.
 */
function fundamentalPeriod(energy: Float64Array, period: number, phase: number, minPeriod: number): number | null {
  let fundamental = period;

  for (let divisor = Math.floor(period / MIN_PERIOD); divisor >= 2; divisor--) {
    const candidate = period / divisor;
    if (candidate < MIN_PERIOD || combScore(energy, candidate, phase) <= 0) continue;
    if (subMultipleSupport(energy, period, phase, divisor) >= HARMONIC_SUPPORT) {
      fundamental = candidate;
      break;
    }
  }

  return fundamental < minPeriod ? null : fundamental;
}

/** Whether most of a comb's teeth found a line, rather than a scattering of them. */
function teethAreLive(energy: Float64Array, period: number, phase: number): boolean {
  const last = energy.length - 1;
  const teeth: number[] = [];
  for (let k = 0; ; k++) {
    const position = phase + k * period;
    if (position > last) break;
    teeth.push(sampleAt(energy, position));
  }

  if (teeth.length < MIN_TEETH) return false;

  const mean = teeth.reduce((sum, value) => sum + value, 0) / teeth.length;
  if (mean <= 0) return false;

  const live = teeth.filter((value) => value >= mean * LIVE_TOOTH_SHARE).length;
  return live / teeth.length >= MIN_LIVE_TEETH;
}

/**
 * Measures the spacing of whatever repeats along one axis.
 *
 * Takes the raw projection from `edgeEnergy` and does the rest: smooth, detrend,
 * scan every whole-pixel period in range for its best phase, judge the winner
 * against the field, drop it to its fundamental, then refine to sub-pixel
 * accuracy. Returns null when nothing in range stands out far enough to be a
 * grid.
 */
export function measureAxis(energy: Float64Array, bounds: AxisBounds): AxisMeasurement | null {
  const last = energy.length - 1;
  const minPeriod = Math.max(MIN_PERIOD, Math.ceil(bounds.minPx));
  // A period only gets MIN_TEETH teeth if it fits MIN_TEETH − 1 times over.
  const maxPeriod = Math.min(Math.floor(bounds.maxPx), Math.floor(last / (MIN_TEETH - 1)));
  if (maxPeriod < minPeriod) return null;

  // The detrending window has to be wider than anything being looked for, or the
  // moving average would follow the grid it is meant to be levelling out.
  const levelled = detrend(smooth(energy), 2 * maxPeriod + 1);

  const scores = new Float64Array(maxPeriod - minPeriod + 1);
  let winner: CombPeak = { period: minPeriod, phase: 0, score: -1 };
  for (let period = minPeriod; period <= maxPeriod; period++) {
    const best = bestComb(levelled, { from: period, to: period, step: 1 }, { step: 1 });
    scores[period - minPeriod] = best.score;
    if (best.score > winner.score) winner = best;
  }
  if (winner.score <= 0) return null;

  const sorted = Array.from(scores).sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;

  const confidence = winner.score / Math.max(median, winner.score / MAX_CONFIDENCE);
  if (confidence < bounds.minConfidence) return null;

  const fundamental = fundamentalPeriod(levelled, winner.period, winner.phase, minPeriod);
  if (fundamental === null) return null;

  // Two narrowing passes. A whole-pixel period is only ever exactly right by
  // luck: 30 squares across a 1000px map are 33.33px apart, and by the tenth
  // line an error of a third of a pixel has become three.
  const coarse = bestComb(
    levelled,
    { from: Math.max(MIN_PERIOD, fundamental - 1), to: fundamental + 1, step: 0.05 },
    { step: 0.5 },
  );
  const fine = bestComb(
    levelled,
    { from: Math.max(MIN_PERIOD, coarse.period - 0.05), to: coarse.period + 0.05, step: 0.005 },
    { step: 0.05, around: coarse.phase, within: 0.5 },
  );

  if (!teethAreLive(levelled, fine.period, fine.phase)) return null;

  return {
    period: fine.period,
    phase: fine.phase,
    confidence,
    teeth: Math.floor((last - fine.phase) / fine.period) + 1,
  };
}
