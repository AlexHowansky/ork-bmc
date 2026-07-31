/** Thumbnail card and the responsive grid it sits in. */
import type { FC } from 'hono/jsx';

import type { MapRecord } from '../models/maps.ts';
import { badge, tagPill } from './ui.ts';

export const MapCard: FC<{ map: MapRecord }> = ({ map }) => (
  <a
    href={`/maps/${map.uuid}`}
    class="group block overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 dark:border-stone-800 dark:bg-stone-900"
  >
    {/* A fixed aspect ratio keeps the grid from reflowing as thumbnails load. */}
    <div class="aspect-4/3 overflow-hidden bg-stone-100 dark:bg-stone-800">
      <img
        src={`/i/${map.uuid}/thumb`}
        alt={`Thumbnail of ${map.name}`}
        loading="lazy"
        decoding="async"
        class="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
      />
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
        {map.gridSize !== null && map.gridWidth !== null && map.gridHeight !== null && (
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
