/**
 * Perceptual fingerprints, for recognising a map that is already in the library.
 *
 * The question this answers is not "are these the same file?" — a cryptographic
 * hash does that, and it is useless here, because re-exporting a map at another
 * size or saving it as a JPEG changes every byte while leaving the same picture.
 * What is wanted is a value that survives rescaling, re-encoding, and a little
 * repainting, so that two hashes can be compared for *likeness*.
 *
 * The construction is the standard DCT perceptual hash:
 *
 *   1. Reduce to a 32×32 greyscale plane. Colour and fine detail are exactly the
 *      things that change between two renders of one map, so both are discarded
 *      before anything else happens. This step is also what makes the hash
 *      indifferent to size: a 1000px map and the 1020px copy the grid fitter
 *      produced from it reduce to the same 32×32 plane.
 *   2. Take a 2D DCT-II. The low-frequency coefficients describe the broad
 *      arrangement of light and dark — the shape of the map — while the high
 *      frequencies carry noise and compression artefacts.
 *   3. Keep the top-left 8×8 block and compare each coefficient against the
 *      median of the block. Using the median rather than the mean means exactly
 *      half the bits are set whatever the image, so no single outlier
 *      coefficient can drag every bit the same way.
 *
 * Two fingerprints are then compared by Hamming distance: 0 means the two images
 * reduce to the same low-frequency description, and 64 means they are opposites.
 * `config.fingerprint.maxDistance` is where "substantially similar" is drawn.
 */
import sharp from 'sharp';

import { config } from '../config.ts';
import type { RawImage } from './grid.ts';

/** Side of the greyscale plane the DCT is taken over. */
export const ANALYSIS_SIZE = 32;

/** Side of the low-frequency block kept from it; 8×8 gives a 64-bit hash. */
export const HASH_SIDE = 8;

export const FINGERPRINT_BITS = HASH_SIDE * HASH_SIDE;
export const FINGERPRINT_HEX_LENGTH = FINGERPRINT_BITS / 4;

const FINGERPRINT_PATTERN = new RegExp(`^[0-9a-f]{${FINGERPRINT_HEX_LENGTH}}$`);

/** True when the value has the shape `perceptualHash` produces. */
export function isValidFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value);
}

/**
 * Cosine basis for the DCT, precomputed once.
 *
 * `basis[k][n] = cos((2n + 1)kπ / 2N)`. Only the first `HASH_SIDE` frequencies
 * are ever read, so the table is that many rows rather than a full N×N.
 */
const BASIS: readonly Float64Array[] = Array.from({ length: HASH_SIDE }, (_, k) => {
  const row = new Float64Array(ANALYSIS_SIZE);
  for (let n = 0; n < ANALYSIS_SIZE; n++) {
    row[n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * ANALYSIS_SIZE));
  }
  return row;
});

/**
 * Computes the 64-bit fingerprint of a greyscale plane.
 *
 * Expects exactly `ANALYSIS_SIZE`² single-channel samples — `fingerprintImage`
 * is what produces one. Kept separate from sharp so the arithmetic can be tested
 * on a hand-built buffer.
 */
export function perceptualHash(raw: RawImage): string {
  if (raw.width !== ANALYSIS_SIZE || raw.height !== ANALYSIS_SIZE) {
    throw new Error(`perceptualHash needs a ${ANALYSIS_SIZE}×${ANALYSIS_SIZE} plane, got ${raw.width}×${raw.height}`);
  }
  if (raw.data.length !== ANALYSIS_SIZE * ANALYSIS_SIZE) {
    throw new Error(`perceptualHash needs one channel; got ${raw.data.length} bytes for ${ANALYSIS_SIZE}² samples`);
  }

  // The 2D DCT is separable, so it is two passes of the 1D transform rather than
  // a quadruple loop: rows first into an intermediate, then columns of that.
  // Only the low frequencies are wanted, which is what keeps this cheap.
  const rows = new Float64Array(ANALYSIS_SIZE * HASH_SIDE);
  for (let y = 0; y < ANALYSIS_SIZE; y++) {
    const offset = y * ANALYSIS_SIZE;
    for (let u = 0; u < HASH_SIDE; u++) {
      const basis = BASIS[u]!;
      let sum = 0;
      for (let x = 0; x < ANALYSIS_SIZE; x++) {
        sum += raw.data[offset + x]! * basis[x]!;
      }
      rows[y * HASH_SIDE + u] = sum;
    }
  }

  const block = new Float64Array(FINGERPRINT_BITS);
  for (let u = 0; u < HASH_SIDE; u++) {
    for (let v = 0; v < HASH_SIDE; v++) {
      const basis = BASIS[v]!;
      let sum = 0;
      for (let y = 0; y < ANALYSIS_SIZE; y++) {
        sum += rows[y * HASH_SIDE + u]! * basis[y]!;
      }
      // The usual orthonormal scaling is omitted: every coefficient is only ever
      // compared against others from the same image, and a common factor cannot
      // change which side of the median a value falls on.
      block[v * HASH_SIDE + u] = sum;
    }
  }

  // An image with no structure at all — a blank fill, a solid colour — has every
  // coefficient but DC at zero, give or take floating-point noise. Comparing
  // that noise against its own median would produce a hash from nothing, and two
  // blank images of different brightness would come out looking unrelated. They
  // are not: they are the same picture. Answer with all zero bits instead.
  let strongest = 0;
  for (let i = 1; i < FINGERPRINT_BITS; i++) {
    strongest = Math.max(strongest, Math.abs(block[i]!));
  }
  if (strongest <= Math.max(Math.abs(block[0]!), 1) * 1e-6) {
    return '0'.repeat(FINGERPRINT_HEX_LENGTH);
  }

  // The DC term is the average brightness of the whole image. It is orders of
  // magnitude larger than everything else, so including it would drag the median
  // up past every other coefficient and leave 63 zero bits. It is excluded from
  // the median, then compared against it like any other bit.
  const forMedian = Array.from(block).slice(1).sort((a, b) => a - b);
  const middle = forMedian.length >> 1;
  const median =
    forMedian.length % 2 === 0 ? (forMedian[middle - 1]! + forMedian[middle]!) / 2 : forMedian[middle]!;

  let hex = '';
  for (let nibble = 0; nibble < FINGERPRINT_HEX_LENGTH; nibble++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) {
      value = (value << 1) | (block[nibble * 4 + bit]! > median ? 1 : 0);
    }
    hex += value.toString(16);
  }

  return hex;
}

/**
 * Fingerprints an encoded image.
 *
 * `fit: 'fill'` rather than 'inside': the aspect ratio is deliberately squashed
 * away so that a map and a differently-cropped version of it still line up
 * feature for feature.
 */
export async function fingerprintImage(bytes: Uint8Array): Promise<string> {
  const plane = await sharp(bytes, { limitInputPixels: config.maxImagePixels })
    .greyscale()
    .resize({ width: ANALYSIS_SIZE, height: ANALYSIS_SIZE, fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();

  return perceptualHash({ data: plane, width: ANALYSIS_SIZE, height: ANALYSIS_SIZE });
}

/** Set bits per hex digit, so a distance is 16 table lookups rather than 64 shifts. */
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;

/**
 * Counts the bits two fingerprints disagree on: 0 for a match, 64 for opposites.
 *
 * Throws rather than tolerating a malformed input. A silent 0 would report every
 * map as a duplicate of every other, which is the worst possible failure here.
 */
export function hammingDistance(a: string, b: string): number {
  if (!isValidFingerprint(a) || !isValidFingerprint(b)) {
    throw new Error('hammingDistance needs two fingerprints in the form perceptualHash returns');
  }

  let distance = 0;
  for (let i = 0; i < FINGERPRINT_HEX_LENGTH; i++) {
    distance += POPCOUNT[parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)]!;
  }
  return distance;
}

/** True when two fingerprints are close enough to be worth showing the admin. */
export function isSimilar(a: string, b: string, maxDistance: number = config.fingerprint.maxDistance): boolean {
  return hammingDistance(a, b) <= maxDistance;
}
