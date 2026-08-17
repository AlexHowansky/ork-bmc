/** Thumbnail card and the responsive grid it sits in. */
import type { FC } from 'hono/jsx';

import type { MapRecord } from '../models/maps.ts';
import { badge, tagPill, thumbWarning } from './ui.ts';

/**
 * A grid is only usable when all three numbers are present, so that is what
 * both the caption and the warning marker key off — one test, so the marker
 * cannot appear on a card that is also printing square counts.
 */
const hasGrid = (map: MapRecord): boolean =>
  map.gridSize !== null && map.gridWidth !== null && map.gridHeight !== null;

export const MapCard: FC<{ map: MapRecord }> = ({ map }) => (
  <a
    href={`/maps/${map.uuid}`}
    class="group block overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 dark:border-stone-800 dark:bg-stone-900"
  >
    {/* A fixed aspect ratio keeps the grid from reflowing as thumbnails load. */}
    <div class="relative aspect-4/3 overflow-hidden bg-stone-100 dark:bg-stone-800">
      <img
        src={`/i/${map.uuid}/thumb`}
        alt={`Thumbnail of ${map.name}`}
        loading="lazy"
        decoding="async"
        class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
      />
      {!hasGrid(map) && (
        // The colour and the shape carry the meaning for anyone who can see
        // them; the text carries it for everyone else.
        <span class={thumbWarning} title="Grid size unknown">
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            class="size-4"
          >
            <path d="M12 2.5a1.6 1.6 0 0 1 1.39.8l8.4 14.6A1.6 1.6 0 0 1 20.4 20.3H3.6a1.6 1.6 0 0 1-1.39-2.4l8.4-14.6A1.6 1.6 0 0 1 12 2.5Zm-1 5.6v5.2h2V8.1h-2Zm0 6.8v2h2v-2h-2Z" />
          </svg>
          <span class="sr-only">Grid size unknown</span>
        </span>
      )}
    </div>

    <div class="p-3">
      <div class="flex items-start justify-between gap-2">
        <h3 class="truncate text-sm font-semibold" title={map.name}>
          {map.name}
        </h3>
        {map.variant && <span class={`shrink-0 ${badge}`}>{map.variant}</span>}
      </div>

      <p class="mt-1 text-xs text-stone-500 dark:text-stone-400">
        {map.imageWidth} × {map.imageHeight}
        {hasGrid(map) && (
          <> · {map.gridWidth}×{map.gridHeight} squares @ {map.gridSize}px</>
        )}
      </p>

      {map.tags.length > 0 && (
        <div class="mt-2 flex flex-wrap gap-1">
          {map.tags.slice(0, 4).map((tag) => (
            <span class={tagPill}>{tag}</span>
          ))}
          {map.tags.length > 4 && (
            <span class="text-xs text-stone-400 dark:text-stone-500">+{map.tags.length - 4}</span>
          )}
        </div>
      )}
    </div>
  </a>
);

export const MapGrid: FC<{ maps: MapRecord[] }> = ({ maps }) => (
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
    {maps.map((map) => (
      <MapCard map={map} />
    ))}
  </div>
);
