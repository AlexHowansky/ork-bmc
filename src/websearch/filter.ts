/**
 * Deciding which of a provider's answers are worth showing an admin.
 *
 * A search returns whatever the index thinks looks similar, which for a battle
 * map means the same map at every size it has ever been published at, plus a
 * quantity of near misses. Only two of those are interesting: copies that are
 * meaningfully bigger than what was uploaded, and copies that are still the same
 * picture rather than a crop of it.
 *
 * Kept apart from the provider so it can be reasoned about — and tested —
 * without a network, and so a second provider would inherit the same judgement
 * rather than reimplementing it.
 */
import type { SearchResult, WebSearchSettings } from './types.ts';

/**
 * How far two aspect ratios may differ and still be called the same picture.
 *
 * This is not fussiness about presentation. Adopting a copy re-resolves the
 * admin's grid against the new dimensions, and a copy that has been cropped or
 * padded no longer holds the same number of squares — `fitGridToCounts` would
 * reject it, on fields the review page does not let them edit. Filtering by
 * shape here means that dead end is never reachable rather than merely handled.
 */
const MAX_ASPECT_DRIFT = 0.01;

export interface StagedSize {
  imageWidth: number;
  imageHeight: number;
}

/**
 * Picks the copies worth offering, best first.
 *
 * Ranked by how many exact matches the provider found before pixel count, so a
 * widely republished copy comes ahead of a marginally larger obscure one — the
 * former is far more likely to be the same file everyone else is using, and the
 * latter is often an upscale of the very image being replaced.
 */
export function selectUpgrades(
  results: SearchResult[],
  staged: StagedSize,
  settings: WebSearchSettings,
): SearchResult[] {
  const stagedPixels = staged.imageWidth * staged.imageHeight;
  const stagedAspect = staged.imageWidth / staged.imageHeight;
  const required = stagedPixels * (1 + settings.minPixelGain);

  return results
    .filter((result) => {
      if (result.width * result.height < required) return false;

      const drift = Math.abs(result.width / result.height - stagedAspect) / stagedAspect;
      return drift <= MAX_ASPECT_DRIFT;
    })
    .sort((a, b) => b.exact - a.exact || b.width * b.height - a.width * a.height)
    .slice(0, settings.maxCandidates);
}
