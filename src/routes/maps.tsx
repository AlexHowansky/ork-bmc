/** Browsing: the paginated listing, search, and the map detail page. */
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';

import { config } from '../config.ts';
import { notFound } from '../errors.ts';
import {
  findMap,
  findSiblingVariants,
  listAllTags,
  parseTagInput,
  searchMaps,
  type MapRecord,
  type SortOrder,
  type TagMode,
} from '../models/maps.ts';
import { CsrfInput } from '../views/Layout.tsx';
import { MapGrid } from '../views/MapCard.tsx';
import { Pagination } from '../views/Pagination.tsx';
import { SearchBar } from '../views/SearchBar.tsx';
import type { AppEnv } from '../types.ts';
import { page } from '../views/render.tsx';
import { badge, badgeWarning, button, card, link, tagPill } from '../views/ui.ts';

export const mapRoutes = new Hono<AppEnv>();

const isTagMode = (value: string): value is TagMode => value === 'any' || value === 'all';
const isSortOrder = (value: string): value is SortOrder =>
  value === 'newest' || value === 'oldest' || value === 'name';

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const EmptyState: FC<{ hasFilters: boolean; isAdmin: boolean }> = ({ hasFilters, isAdmin }) => (
  <div class={`mt-6 px-6 py-16 text-center ${card}`}>
    <p class="text-4xl" aria-hidden="true">
      {hasFilters ? '🔍' : '🗺️'}
    </p>
    <h2 class="mt-4 text-lg font-semibold">{hasFilters ? 'No maps match that search' : 'No maps yet'}</h2>
    <p class="mx-auto mt-2 max-w-md text-sm text-stone-600 dark:text-stone-400">
      {hasFilters
        ? 'Try fewer tags, switch tag matching from All to Any, or clear the search to see everything.'
        : isAdmin
          ? 'Upload your first battle map to start the library.'
          : 'An administrator has not uploaded any maps yet.'}
    </p>
    <div class="mt-6 flex justify-center gap-3">
      {hasFilters && (
        <a href="/maps" class={button.secondary}>
          Clear search
        </a>
      )}
      {isAdmin && !hasFilters && (
        <a href="/maps/new" class={button.primary}>
          Upload a map
        </a>
      )}
    </div>
  </div>
);

mapRoutes.get('/maps', (c) => {
  const user = c.get('user')!;

  const text = (c.req.query('q') ?? '').trim().slice(0, 200);
  const rawTags = (c.req.query('tags') ?? '').trim().slice(0, 500);
  const modeParam = c.req.query('mode') ?? 'any';
  const sortParam = c.req.query('sort') ?? 'newest';
  const pageParam = Number(c.req.query('page') ?? '1');

  const tagMode: TagMode = isTagMode(modeParam) ? modeParam : 'any';
  const sort: SortOrder = isSortOrder(sortParam) ? sortParam : 'newest';
  const currentPage = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  // Reuse the same normalisation the upload form applies, so searching for
  // "Forest" finds maps tagged "forest".
  const { tags } = parseTagInput(rawTags);

  const results = searchMaps({
    text,
    tags,
    tagMode,
    sort,
    page: currentPage,
    perPage: config.pageSize,
  });

  const hasFilters = text !== '' || tags.length > 0;

  const query: Record<string, string> = {};
  if (text) query['q'] = text;
  if (rawTags) query['tags'] = rawTags;
  if (tagMode !== 'any') query['mode'] = tagMode;
  if (sort !== 'newest') query['sort'] = sort;

  return page(
    c,
    { title: hasFilters ? `Search · ${results.total} results` : 'Maps' },
    <div>
      {/* No heading and no upload button: the nav names the page, and carries
          the admin's link to the upload form. */}
      <SearchBar
        text={text}
        tags={rawTags}
        tagMode={tagMode}
        sort={sort}
        popularTags={listAllTags().slice(0, 15)}
        hasFilters={hasFilters}
      />

      {results.maps.length === 0 ? (
        <EmptyState hasFilters={hasFilters} isAdmin={user.role === 'admin'} />
      ) : (
        <>
          <div class="mt-6">
            <MapGrid maps={results.maps} />
          </div>
          <Pagination page={results.page} totalPages={results.totalPages} total={results.total} query={query} />
        </>
      )}
    </div>,
  );
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const MetadataRow: FC<{ term: string; children: unknown }> = ({ term, children }) => (
  <div class="flex justify-between gap-4 border-b border-stone-100 py-2 last:border-0 dark:border-stone-800">
    <dt class="text-sm text-stone-500 dark:text-stone-400">{term}</dt>
    <dd class="text-right text-sm font-medium">{children}</dd>
  </div>
);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const GRID_SOURCE_LABEL: Record<string, string> = {
  none: 'Not recorded',
  user: 'Entered manually',
  detected: 'Detected automatically',
  estimated: 'Estimated — please check',
};

mapRoutes.get('/maps/:uuid', (c) => {
  const map = findMap(c.req.param('uuid'));
  if (!map) throw notFound('That map does not exist.');

  const user = c.get('user')!;
  const siblings = findSiblingVariants(map.uuid, map.name);
  const hasGrid = map.gridSize !== null && map.gridWidth !== null && map.gridHeight !== null;

  return page(
    c,
    {
      title: map.variant ? `${map.name} (${map.variant})` : map.name,
      // Only emit the overlay stylesheet when there is a grid to draw.
      ...(hasGrid ? { gridOverlay: { columns: map.gridWidth!, rows: map.gridHeight! } } : {}),
    },
    <div>
      {/* No back link: the nav bar carries the way back to the listing. */}
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold tracking-tight">
            {map.name}
            {map.variant && <span class={`ml-3 align-middle ${badge}`}>{map.variant}</span>}
          </h1>
          {map.tags.length > 0 && (
            <div class="mt-3 flex flex-wrap gap-1.5">
              {map.tags.map((tag) => (
                <a href={`/maps?tags=${encodeURIComponent(tag)}`} class={tagPill}>
                  {tag}
                </a>
              ))}
            </div>
          )}
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <a href={`/i/${map.uuid}/download`} class={button.primary}>
            Download
          </a>
          {user.role === 'admin' && (
            <>
              <a href={`/maps/${map.uuid}/edit`} class={button.secondary}>
                Edit
              </a>
              {/* A POST, so a crawler or prefetch cannot delete a map. */}
              <form method="post" action={`/maps/${map.uuid}/delete`} data-confirm-delete>
                <CsrfInput token={c.get('csrfToken')} />
                <button type="submit" class={button.danger}>
                  Delete
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      <div class="mt-6 grid gap-6 lg:grid-cols-3">
        <div class="lg:col-span-2">
          {/*
            CSS-only overlay toggle, no JavaScript involved. The checkbox is the
            `peer`, so both following siblings can react to its checked state —
            which is why the checkbox sits at this level rather than inside the
            toggle row.
          */}
          {hasGrid && <input type="checkbox" id="grid-toggle" class="peer sr-only" />}

          {hasGrid && (
            <div class="mb-3 flex flex-wrap items-center gap-2 peer-checked:[&>label]:border-amber-500 peer-checked:[&>label]:text-amber-700 dark:peer-checked:[&>label]:text-amber-400">
              <label for="grid-toggle" class={`cursor-pointer select-none ${button.secondary}`}>
                Show grid overlay
              </label>
              <span class="text-xs text-stone-500 dark:text-stone-400">
                Check that the overlay lines up with the painted grid.
              </span>
            </div>
          )}

          <div class="relative overflow-hidden rounded-xl border border-stone-200 bg-stone-100 peer-checked:[&_.map-grid-overlay]:block dark:border-stone-800 dark:bg-stone-900">
            {/*
              Full size on click, CSS-only like the grid toggle above. Both
              labels drive the same checkbox: the one around the image opens the
              view, the one behind it closes again. The checkbox sits inside this
              container rather than beside the grid one, so the two sets of
              `peer-checked:` rules are in different sibling groups and cannot
              trip over each other.
            */}
            <input type="checkbox" id="full-size" class="peer sr-only" data-lightbox-toggle />

            <label for="full-size" class="block cursor-zoom-in" title="Show full size">
              <img
                src={`/i/${map.uuid}/full`}
                alt={map.name}
                width={map.imageWidth}
                height={map.imageHeight}
                class="block h-auto w-full"
              />
              <span class="sr-only"> — show full size</span>
            </label>

            {hasGrid && (
              <div
                aria-hidden="true"
                class="map-grid-overlay grid-overlay pointer-events-none absolute inset-0 hidden [--grid-overlay-color:rgba(220,38,38,0.6)]"
              />
            )}

            {/*
              `max-w-none` defeats the base stylesheet's `max-width: 100%`, which
              is the whole point: the image is shown at its stored pixel size and
              the overlay scrolls. Centred with `mx-auto` rather than flex, so an
              image wider than the viewport is not clipped on its left edge.
            */}
            <label
              for="full-size"
              class="fixed inset-0 z-50 hidden cursor-zoom-out overflow-auto bg-stone-950/90 p-4 peer-checked:block"
            >
              <img
                src={`/i/${map.uuid}/full`}
                alt=""
                width={map.imageWidth}
                height={map.imageHeight}
                // Same URL as the image above, so opening the view costs a cache
                // hit rather than a second download — but not decoded until then.
                loading="lazy"
                class="mx-auto max-w-none"
              />
              <span class="sr-only">Close the full-size view</span>
            </label>
          </div>
        </div>

        <aside class="space-y-6">
          <div class={`p-5 ${card}`}>
            <h2 class="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">Details</h2>
            <dl class="mt-3">
              <MetadataRow term="Image size">
                {map.imageWidth} × {map.imageHeight} px
              </MetadataRow>
              <MetadataRow term="File size">{formatBytes(map.fileSize)}</MetadataRow>
              <MetadataRow term="Format">WEBP (lossless)</MetadataRow>
              {map.variant && <MetadataRow term="Variant">{map.variant}</MetadataRow>}
              <MetadataRow term="Added">{new Date(map.createdAt).toISOString().slice(0, 10)}</MetadataRow>
            </dl>
          </div>

          <div class={`p-5 ${card}`}>
            <h2 class="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">Grid</h2>
            {hasGrid ? (
              <dl class="mt-3">
                <MetadataRow term="Grid size">{map.gridSize} px per square</MetadataRow>
                <MetadataRow term="Squares across">{map.gridWidth}</MetadataRow>
                <MetadataRow term="Squares down">{map.gridHeight}</MetadataRow>
                <MetadataRow term="Source">
                  {map.gridSource === 'estimated' ? (
                    <span class={badgeWarning}>{GRID_SOURCE_LABEL[map.gridSource]}</span>
                  ) : (
                    GRID_SOURCE_LABEL[map.gridSource]
                  )}
                </MetadataRow>
                {map.upscaleFactor > 1 && (
                  <MetadataRow term="Upscaled">{map.upscaleFactor.toFixed(3)}×</MetadataRow>
                )}
              </dl>
            ) : (
              <div class="mt-3 text-sm text-stone-600 dark:text-stone-400">
                <p>No grid recorded for this map.</p>
                {user.role === 'admin' && (
                  <p class="mt-2">
                    <a href={`/maps/${map.uuid}/edit`} class={link}>
                      Add the grid details
                    </a>{' '}
                    so this map can be scaled correctly in a virtual tabletop.
                  </p>
                )}
              </div>
            )}
          </div>

          {siblings.length > 0 && (
            <div class={`p-5 ${card}`}>
              <h2 class="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Other variants
              </h2>
              <ul class="mt-3 space-y-2">
                {siblings.map((sibling) => (
                  <li>
                    <a href={`/maps/${sibling.uuid}`} class="flex items-center gap-3 text-sm hover:underline">
                      <img
                        src={`/i/${sibling.uuid}/thumb`}
                        alt=""
                        loading="lazy"
                        class="h-10 w-10 rounded object-cover"
                      />
                      <span class="font-medium">{sibling.variant || 'default'}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>,
  );
});

export type { MapRecord };
