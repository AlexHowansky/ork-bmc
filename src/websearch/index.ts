/**
 * Looking for a better copy of a freshly staged upload.
 *
 * The whole exchange lives here: give the staged image a brief public address,
 * ask a provider what else looks like it, keep the copies that are meaningfully
 * bigger, fetch a thumbnail of each so the admin can compare them, and record
 * the lot against the staged upload. Then take the address away again.
 *
 * The one rule this module keeps above all others is that **nothing escapes**.
 * It sits directly in the upload path, and an admin who has just handed over a
 * file cares about their map being saved, not about a search API's uptime. Every
 * failure — a dead provider, a bad key, an exhausted quota, a thumbnail that
 * will not download — is logged and turned into "no candidates". The upload goes
 * through either way.
 *
 * The four ways a search does not happen at all, checked in this order because
 * each is cheaper than the last: the admin unticked the box, no provider is
 * configured, the image is already big enough that no copy could improve it, or
 * the monthly budget is spent.
 */
import sharp from 'sharp';

import { config } from '../config.ts';
import { encodeAs } from '../images/process.ts';
import type { Logger } from '../log.ts';
import { clearShareToken, mintShareToken, type PendingUpload } from '../models/pendingUploads.ts';
import { replaceCandidates, type UploadCandidateInput } from '../models/uploadCandidates.ts';
import { consumeToken } from '../security/ratelimit.ts';
import { selectUpgrades } from './filter.ts';
import { fetchRemoteImage } from './fetchImage.ts';
import { search } from './serpapi.ts';
import type { SearchResult, WebSearchSettings } from './types.ts';

/**
 * Longest edge of a stored candidate thumbnail.
 *
 * Smaller than a map's own thumbnail because it is only ever a row in a list,
 * and because these are held as bytes in the database rather than as files.
 */
const CANDIDATE_THUMB_SIZE = 200;

/** Ceiling on a candidate thumbnail download; a preview has no business being large. */
const CANDIDATE_THUMB_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The rolling budget, spent one token per search.
 *
 * A token bucket rather than a counter reset on the first of the month: it
 * refills continuously, so a burst of uploads costs the following days a little
 * rather than stranding the rest of the month at zero.
 */
const QUOTA_KEY = 'websearch:monthly';
const QUOTA_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export interface SearchRequest {
  /** False when the admin unticked the box on the upload form. */
  wanted: boolean;
  logger: Logger;
}

/**
 * Finds and records copies of a staged upload that are worth swapping it for.
 *
 * Returns how many were found. The rows themselves are read back through
 * `candidatesFor`, so a caller that only needs to know whether to interrupt the
 * upload does not have to carry them.
 */
export async function findHigherResolution(
  pending: PendingUpload,
  request: SearchRequest,
  /** Overridable so the containment below can be exercised without a live key. */
  settings: WebSearchSettings = config.webSearch,
): Promise<number> {
  const logger = request.logger;

  if (!request.wanted) return 0;
  if (settings.provider === 'none') return 0;

  if (pending.imageWidth * pending.imageHeight >= settings.skipAbovePixels) {
    logger.debug('skipped web search: upload is already large', {
      uuid: pending.uuid,
      imageWidth: pending.imageWidth,
      imageHeight: pending.imageHeight,
    });
    return 0;
  }

  if (!consumeToken(QUOTA_KEY, { capacity: settings.monthlyLimit, windowSeconds: QUOTA_WINDOW_SECONDS })) {
    logger.warn('skipped web search: monthly budget spent', { uuid: pending.uuid, limit: settings.monthlyLimit });
    return 0;
  }

  const startedAt = Date.now();

  try {
    const token = mintShareToken(pending.uuid);
    let results: SearchResult[];
    try {
      results = await search(`${settings.publicBaseUrl}/staged-image?t=${token}`, settings);
    } finally {
      // Whatever happened, the image stops being readable now rather than when
      // the token would have expired on its own.
      clearShareToken(pending.uuid);
    }

    const upgrades = selectUpgrades(results, pending, settings);
    const candidates = await withThumbnails(upgrades, logger);
    replaceCandidates(pending.uuid, candidates);

    logger.info('web search completed', {
      uuid: pending.uuid,
      provider: settings.provider,
      durationMs: Date.now() - startedAt,
      results: results.length,
      candidates: candidates.length,
    });

    return candidates.length;
  } catch (error) {
    // Never rethrown. An upload must not fail because a search did.
    logger.warn('web search failed', {
      uuid: pending.uuid,
      provider: settings.provider,
      durationMs: Date.now() - startedAt,
      error,
    });
    return 0;
  }
}

/**
 * Attaches a locally stored preview to each candidate.
 *
 * The content security policy allows images from this origin only, so a remote
 * thumbnail cannot simply be linked — it has to be fetched here and served back
 * by this app. A candidate whose thumbnail will not download is still offered,
 * without a picture; the admin can follow the source link instead, and losing
 * the preview is a much smaller loss than losing the candidate.
 */
async function withThumbnails(results: SearchResult[], logger: Logger): Promise<UploadCandidateInput[]> {
  return await Promise.all(
    results.map(async (result) => {
      const thumb = result.thumbnailUrl ? await thumbnailFor(result.thumbnailUrl, logger) : null;

      return {
        imageUrl: result.imageUrl,
        pageUrl: result.pageUrl,
        source: result.source,
        title: result.title,
        width: result.width,
        height: result.height,
        exact: result.exact,
        thumb,
        thumbFormat: thumb ? config.image.format : null,
      } satisfies UploadCandidateInput;
    }),
  );
}

async function thumbnailFor(url: string, logger: Logger): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    // Lens frequently inlines its thumbnails, which is the cheap case: no
    // request to make and nothing to guard against.
    const bytes = url.startsWith('data:')
      ? decodeDataUri(url)
      : await fetchRemoteImage(url, {
          maxBytes: CANDIDATE_THUMB_MAX_BYTES,
          timeoutMs: config.webSearch.timeoutMs,
        });

    if (!bytes) return null;

    const encoded = await encodeAs(
      sharp(bytes, { limitInputPixels: config.maxImagePixels, failOn: 'error' }).resize({
        width: CANDIDATE_THUMB_SIZE,
        height: CANDIDATE_THUMB_SIZE,
        fit: 'inside',
        withoutEnlargement: true,
      }),
      { format: config.image.format, quality: config.thumbQuality, lossless: false },
    ).toBuffer();

    // Copied out of the Buffer it arrives in, so what is handed to SQLite owns
    // its own memory rather than a view onto sharp's.
    return new Uint8Array(encoded);
  } catch (error) {
    logger.debug('candidate thumbnail could not be prepared', { error });
    return null;
  }
}

/** Reads a `data:` URI's payload, or null if it is not one this can use. */
function decodeDataUri(url: string): Uint8Array | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;

  const [, , base64, payload = ''] = match;

  return base64
    ? Uint8Array.from(Buffer.from(payload, 'base64'))
    : new TextEncoder().encode(decodeURIComponent(payload));
}
