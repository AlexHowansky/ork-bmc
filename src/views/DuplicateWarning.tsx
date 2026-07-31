/** The panel shown when an upload looks like a map that is already in the library. */
import type { FC } from 'hono/jsx';

import { FINGERPRINT_BITS } from '../images/fingerprint.ts';
import type { SimilarMap } from '../models/maps.ts';
import { badge, badgeWarning, card, link } from './ui.ts';

/**
 * Describes how close a match is without making the admin read a bit count.
 *
 * The thresholds are deliberately coarse. The number that matters is whether the
 * two are the same map, and only a person looking at both thumbnails can answer
 * that — the wording is there to say how strongly the software suspects it, not
 * to be precise about a measurement it cannot interpret.
 */
export function similarityLabel(distance: number): string {
  if (distance === 0) return 'Identical';
  if (distance <= 4) return 'Almost identical';
  if (distance <= 8) return 'Very similar';
  return 'Similar';
}

/** Rough percentage of the fingerprint's bits the two images agree on. */
export function similarityPercent(distance: number): number {
  return Math.round(((FINGERPRINT_BITS - distance) / FINGERPRINT_BITS) * 100);
}

const Match: FC<{ similar: SimilarMap }> = ({ similar }) => (
  <li class="flex items-center gap-4 py-3">
    <img
      src={`/i/${similar.map.uuid}/thumb`}
      alt={`Thumbnail of ${similar.map.name}`}
      loading="lazy"
      decoding="async"
      width="72"
      height="72"
      class="h-18 w-18 shrink-0 rounded-lg border border-stone-200 object-cover dark:border-stone-700"
    />
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        {/* A new tab, so comparing the two does not throw away the staged upload. */}
        <a
          href={`/maps/${similar.map.uuid}`}
          target="_blank"
          rel="noopener noreferrer"
          class={`truncate ${link}`}
          title={similar.map.name}
        >
          {similar.map.name}
        </a>
        {similar.map.variant && <span class={badge}>{similar.map.variant}</span>}
      </div>
      <p class="mt-1 text-xs text-stone-500 dark:text-stone-400">
        {similarityLabel(similar.distance)} — {similarityPercent(similar.distance)}% match ·{' '}
        {similar.map.imageWidth} × {similar.map.imageHeight}
        {similar.map.gridSize !== null && <> · {similar.map.gridSize}px squares</>}
      </p>
    </div>
  </li>
);

export const DuplicateWarning: FC<{ matches: SimilarMap[] }> = ({ matches }) => (
  <div
    role="alert"
    class="rounded-xl border border-amber-300 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950/40"
  >
    <div class="flex flex-wrap items-center gap-3">
      <span class={badgeWarning}>Possible duplicate</span>
      <h2 class="text-lg font-semibold text-amber-900 dark:text-amber-200">
        {matches.length === 1
          ? 'This looks like a map you already have'
          : `This looks like ${matches.length} maps you already have`}
      </h2>
    </div>

    <p class="mt-3 text-sm text-amber-900 dark:text-amber-200">
      Nothing has been saved yet. If this really is a new version of the same map — a night-time render, a flooded
      one, a copy with the tokens removed — keep the name below as it is and give this one a{' '}
      <strong class="font-semibold">variant</strong> instead. It will then sit alongside the map it belongs with
      rather than starting a second entry for the same place.
    </p>

    <p class="mt-2 text-sm text-amber-900 dark:text-amber-200">
      If it is genuinely a different map, change the name to whatever you meant and save it as normal.
    </p>

    <div class={`mt-5 px-4 ${card}`}>
      <ul class="divide-y divide-stone-100 dark:divide-stone-800">
        {matches.map((similar) => (
          <Match similar={similar} />
        ))}
      </ul>
    </div>
  </div>
);
