/**
 * Google Lens, through SerpApi.
 *
 * Lens is the only widely available index that answers "where else does this
 * exact picture appear", which is the question worth asking about a battle map —
 * the same map is republished, rescaled and recompressed constantly, and the
 * best copy is rarely the one that reached us.
 *
 * `type=visual_matches` rather than `type=exact_matches`, which sounds like the
 * better fit and is not: an exact match reports the page an image was found on
 * and a reduced thumbnail, but no address for the original file, so there would
 * be nothing to download. A visual match carries `image` alongside its true
 * dimensions and a count of how many exact matches it has, which is everything
 * needed to rank a copy and then go and get it. "Visual" is a looser claim than
 * this feature wants, but it is not the claim that decides anything: whether a
 * downloaded copy really is the same map is settled by its fingerprint.
 *
 * This module only asks and translates. It applies no policy about which
 * candidates are worth showing — that is `selectUpgrades` in `./filter.ts`.
 */
import { AppError } from '../errors.ts';
import type { SearchResult, WebSearchSettings } from './types.ts';

const ENDPOINT = 'https://serpapi.com/search.json';

/** Seam for tests. There is no DNS check here: the host is ours, not a result's. */
export interface SerpApiDeps {
  fetch?: typeof globalThis.fetch;
}

interface VisualMatch {
  title?: unknown;
  link?: unknown;
  source?: unknown;
  thumbnail?: unknown;
  image?: unknown;
  image_width?: unknown;
  image_height?: unknown;
  exact_matches?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const positiveInt = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Asks Lens what else looks like the image at `imageUrl`.
 *
 * `imageUrl` has to be somewhere SerpApi's own fetcher can reach, which is why
 * the staged image gets a short-lived public address before this is called.
 *
 * Throws `AppError` on anything that stops an answer coming back. The caller
 * treats that as "no candidates" — a search provider having a bad day must never
 * turn into an upload failing.
 */
export async function search(
  imageUrl: string,
  settings: WebSearchSettings,
  deps: SerpApiDeps = {},
): Promise<SearchResult[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;

  const url = new URL(ENDPOINT);
  url.searchParams.set('engine', 'google_lens');
  url.searchParams.set('type', 'visual_matches');
  url.searchParams.set('url', imageUrl);
  url.searchParams.set('api_key', settings.apiKey);

  const response = await doFetch(url, {
    signal: AbortSignal.timeout(settings.timeoutMs),
    headers: { accept: 'application/json' },
  });

  if (!response.ok) {
    // Deliberately the status and nothing else. The URL carries the API key in a
    // query parameter, so it must not travel into an error, a log, or a cause.
    throw new AppError('The image search could not be reached.', {
      code: 'web_search_failed',
      cause: `serpapi responded ${response.status}`,
    });
  }

  const body = (await response.json()) as { visual_matches?: unknown; error?: unknown };

  // SerpApi reports "no results found" and a bad key the same way: a 200 with an
  // `error` string. Neither is worth failing an upload over.
  if (typeof body.error === 'string') {
    throw new AppError('The image search returned no answer.', {
      code: 'web_search_failed',
      cause: body.error,
    });
  }

  const matches = Array.isArray(body.visual_matches) ? (body.visual_matches as VisualMatch[]) : [];

  return matches.flatMap((match) => {
    const imageUrlValue = text(match.image);
    const width = positiveInt(match.image_width);
    const height = positiveInt(match.image_height);

    // Lens returns plenty of results with no original image or no dimensions —
    // a shopping listing, a video, a page it could only thumbnail. Nothing can be
    // offered about a copy whose size is unknown or which cannot be fetched.
    if (!imageUrlValue || width === null || height === null) return [];

    return [
      {
        imageUrl: imageUrlValue,
        pageUrl: text(match.link),
        source: text(match.source),
        title: text(match.title),
        width,
        height,
        thumbnailUrl: text(match.thumbnail),
        exact: positiveInt(match.exact_matches) ?? 0,
      } satisfies SearchResult,
    ];
  });
}
