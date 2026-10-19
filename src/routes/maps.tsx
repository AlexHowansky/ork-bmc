/** Browsing: the paginated listing, search, and the map detail page. */
import { Hono } from 'hono';
import type { FC } from 'hono/jsx';

import { config } from '../config.ts';
import { carriesSearch, forgetSearch, rememberedSearch, rememberSearch } from '../searchMemory.ts';
import { FORMAT_LABELS } from '../images/process.ts';
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
import { badge, badgeWarning, button, card, gridOverlay, link, muted, tagPill } from '../views/ui.ts';

export const mapRoutes = new Hono<AppEnv>();

const isTagMode = (value: string): value is TagMode => value === 'any' || value === 'all';
const isSortOrder = (value: string): value is SortOrder =>
  value === 'newest' || value === 'oldest' || value === 'name';

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const EmptyState: FC<{ hasFilters: boolean; isAdmin: boolean }> = ({ hasFilters, isAdmin }) => (
  <div class={`mt-6 ${card}`}>
    <div class="card-body items-center py-16 text-center">
      <p class="text-4xl" aria-hidden="true">
        {hasFilters ? '🔍' : '🗺️'}
      </p>
      <h2 class="card-title">{hasFilters ? 'No maps match that search' : 'No maps yet'}</h2>
      <p class={`max-w-md text-sm ${muted}`}>
        {hasFilters
          ? 'Try fewer tags, switch tag matching from All to Any, or clear the search to see everything.'
          : isAdmin
            ? 'Upload your first battle map to start the library.'
            : 'An administrator has not uploaded any maps yet.'}
      </p>
      <div class="card-actions mt-4">
        {hasFilters && (
          <a href="/maps?clear=1" class={button.secondary}>
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
  </div>
);

interface Criteria {
  text: string;
  rawTags: string;
  tagMode: TagMode;
  sort: SortOrder;
}

/**
 * Validates a search from wherever it came — the query string on this request,
 * or the one remembered from the last.
 *
 * One reader for both, so a value restored from the cookie is held to exactly
 * the same standard as one that was just typed, and neither can carry anything
 * unvalidated into a query or a redirect.
 */
function readCriteria(get: (name: string) => string | undefined): Criteria {
  const modeParam = get('mode') ?? 'any';
  const sortParam = get('sort') ?? 'newest';

  return {
    text: (get('q') ?? '').trim().slice(0, 200),
    rawTags: (get('tags') ?? '').trim().slice(0, 500),
    tagMode: isTagMode(modeParam) ? modeParam : 'any',
    sort: isSortOrder(sortParam) ? sortParam : 'newest',
  };
}

/** The canonical query string for a search: only what differs from the default. */
function toQuery({ text, rawTags, tagMode, sort }: Criteria): Record<string, string> {
  const query: Record<string, string> = {};
  if (text) query['q'] = text;
  if (rawTags) query['tags'] = rawTags;
  if (tagMode !== 'any') query['mode'] = tagMode;
  if (sort !== 'newest') query['sort'] = sort;
  return query;
}

mapRoutes.get('/maps', (c) => {
  const user = c.get('user')!;

  // Clearing has to be an act of its own: simply arriving at the listing is what
  // restores the last search, so it cannot also be what discards it.
  if (c.req.query('clear') !== undefined) {
    forgetSearch(c);
    return c.redirect('/maps', 302);
  }

  // No search of its own — a nav link, or a return trip from a map. Put the last
  // one back, and in the URL rather than silently, so what is on screen is
  // always what the address says.
  if (!carriesSearch(c)) {
    const restored = toQuery(readCriteria((name) => new URLSearchParams(rememberedSearch(c)).get(name) ?? undefined));
    if (Object.keys(restored).length > 0) {
      return c.redirect(`/maps?${new URLSearchParams(restored).toString()}`, 302);
    }
  }

  const criteria = readCriteria((name) => c.req.query(name));
  const { text, rawTags, tagMode, sort } = criteria;

  const pageParam = Number(c.req.query('page') ?? '1');
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

  const query = toQuery(criteria);
  // Remembered from the canonical form, so what comes back is what this page
  // would have been anyway. An empty query is a search of nothing, which forgets.
  rememberSearch(c, new URLSearchParams(query).toString());

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
        hasQuery={Object.keys(query).length > 0}
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
  <div class="flex justify-between gap-4 py-2">
    <dt class="text-sm text-base-content/60">{term}</dt>
    <dd class="text-right text-sm font-medium">{children}</dd>
  </div>
);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `2026-07-31 14:23 UTC` — minutes are as fine as "when was this added" needs. */
function formatUtc(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A moment in time, rendered in UTC because the server has no way of knowing the
 * reader's zone.
 *
 * `public/app.js` rewrites the text in the reader's own zone and keeps the UTC
 * reading on the title, so the page is right either way — with JavaScript off it
 * is simply UTC, which is at least unambiguous about which it is.
 */
const Timestamp: FC<{ epochMs: number }> = ({ epochMs }) => (
  <time datetime={new Date(epochMs).toISOString()} data-local-time>
    {formatUtc(epochMs)}
  </time>
);

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

      <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {/*
          CSS only, no JavaScript involved: the grid switch shows the overlay
          through `has-[]` on this column, and the full-size view is a daisyUI
          modal opened and closed by a checkbox.
        */}
        <div class="has-[#grid-toggle:checked]:[&_.map-grid-overlay]:block">
          {hasGrid && (
            <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              <label class="label text-sm text-base-content">
                <input type="checkbox" id="grid-toggle" class="toggle toggle-sm" />
                Show grid overlay
              </label>
              <span class="text-xs text-base-content/60">
                Check that the overlay lines up with the painted grid.
              </span>
            </div>
          )}

          {/* Never wider than the image's own pixels: `w-fit` shrinks the
              figure to the image, so the overlay still covers it exactly. */}
          <figure class="relative w-fit max-w-full overflow-hidden rounded-box border border-base-300 bg-base-200">
            <label for="full-size" class="block cursor-zoom-in" title="Show full size">
              <img
                src={`/i/${map.uuid}/full`}
                alt={map.name}
                width={map.imageWidth}
                height={map.imageHeight}
                class="block h-auto max-w-full"
              />
              <span class="sr-only"> — show full size</span>
            </label>

            {hasGrid && (
              <div
                aria-hidden="true"
                class={`map-grid-overlay pointer-events-none absolute inset-0 hidden ${gridOverlay}`}
              />
            )}
          </figure>

          {/*
            `modal-toggle` must sit directly before the modal for daisyUI to
            open it, and daisyUI also freezes the page behind it while it is
            checked. The box is itself a label, so a click on the map closes the
            view as well as one on the backdrop. `max-w-none` on the image is
            the whole point: it is shown at its stored pixel size and the box
            scrolls.
          */}
          <input type="checkbox" id="full-size" class="modal-toggle" data-lightbox-toggle />
          <div class="modal" role="dialog" aria-label={`${map.name}, full size`}>
            <label
              for="full-size"
              class="modal-box w-auto max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] cursor-zoom-out overflow-auto p-0"
            >
              <img
                src={`/i/${map.uuid}/full`}
                alt=""
                width={map.imageWidth}
                height={map.imageHeight}
                // Same URL as the image above, so opening the view costs a cache
                // hit rather than a second download — but not decoded until then.
                loading="lazy"
                class="max-w-none"
              />
              <span class="sr-only">Close the full-size view</span>
            </label>
            <label for="full-size" class="modal-backdrop">
              Close
            </label>
          </div>
        </div>

        <aside class="space-y-6">
          <div class={`card-sm ${card}`}>
            <div class="card-body">
              <h2 class="card-title text-xs uppercase tracking-wide text-base-content/60">Details</h2>
              <dl class="divide-y divide-base-300">
                <MetadataRow term="Image size">
                  {map.imageWidth} × {map.imageHeight} px
                </MetadataRow>
                <MetadataRow term="File size">{formatBytes(map.fileSize)}</MetadataRow>
                <MetadataRow term="Format">{FORMAT_LABELS[map.format]}</MetadataRow>
                {map.variant && <MetadataRow term="Variant">{map.variant}</MetadataRow>}
                <MetadataRow term="Added">
                  <Timestamp epochMs={map.createdAt} />
                </MetadataRow>
              </dl>
            </div>
          </div>

          <div class={`card-sm ${card}`}>
            <div class="card-body">
              <h2 class="card-title text-xs uppercase tracking-wide text-base-content/60">Grid</h2>
              {hasGrid ? (
                <dl class="divide-y divide-base-300">
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
                <div class={`text-sm ${muted}`}>
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
          </div>

          {siblings.length > 0 && (
            <div class={`card-sm ${card}`}>
              <div class="card-body">
                <h2 class="card-title text-xs uppercase tracking-wide text-base-content/60">Other variants</h2>
                <ul class="list">
                  {siblings.map((sibling) => (
                    <li class="list-row items-center px-0 py-2">
                      <img
                        src={`/i/${sibling.uuid}/thumb`}
                        alt=""
                        loading="lazy"
                        class="size-10 rounded-field object-cover"
                      />
                      <a href={`/maps/${sibling.uuid}`} class={`text-sm font-medium ${link}`}>
                        {sibling.variant || 'default'}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>,
  );
});

export type { MapRecord };
