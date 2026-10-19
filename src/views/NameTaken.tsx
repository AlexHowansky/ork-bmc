/** The panel shown when an upload arrives under a name the library already has. */
import type { FC } from 'hono/jsx';

import type { MapRecord } from '../models/maps.ts';
import { badge, badgeWarning, card, link, warningPanel } from './ui.ts';

const Namesake: FC<{ map: MapRecord }> = ({ map }) => (
  <li class="list-row items-center">
    <img
      src={`/i/${map.uuid}/thumb`}
      alt={`Thumbnail of ${map.name}`}
      loading="lazy"
      decoding="async"
      width="72"
      height="72"
      class="size-18 rounded-field border border-base-300 object-cover"
    />
    <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        {/* A new tab, so looking does not throw away the staged upload. */}
        <a href={`/maps/${map.uuid}`} target="_blank" rel="noopener noreferrer" class={`truncate ${link}`}>
          {map.name}
        </a>
        <span class={badge}>{map.variant || 'no variant'}</span>
      </div>
      <p class="mt-1 text-xs text-base-content/60">
        {map.imageWidth} × {map.imageHeight}
        {map.gridSize !== null && <> · {map.gridSize}px squares</>}
      </p>
    </div>
  </li>
);

/**
 * Asks the question a reused name raises: another version of that map, or a
 * different map that needs a name of its own. Both answers are the form below —
 * a variant, or a new name — so this only has to explain them.
 */
export const NameTaken: FC<{ name: string; maps: MapRecord[] }> = ({ name, maps }) => (
  <div role="alert" class={warningPanel}>
    <div class="card-body">
      <div class="flex flex-wrap items-center gap-3">
        <span class={badgeWarning}>Name already in use</span>
        <h2 class="card-title">
          {maps.length === 1
            ? `You already have a map called “${name}”`
            : `You already have ${maps.length} maps called “${name}”`}
        </h2>
      </div>

      <p>
        Nothing has been saved yet. If this is another version of the same map — a night-time render, a flooded one —
        keep the name and give it a <strong class="font-semibold">variant</strong> below, and it will be listed
        alongside {maps.length === 1 ? 'it' : 'them'}.
      </p>

      <p>If it is a different map, give it a different name.</p>

      <ul class={`list mt-2 ${card}`}>
        {maps.map((map) => (
          <Namesake map={map} />
        ))}
      </ul>
    </div>
  </div>
);
