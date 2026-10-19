/** Search controls: name text, tags, AND/OR mode, and sort order. */
import type { FC } from 'hono/jsx';

import type { SortOrder, TagMode } from '../models/maps.ts';
import { button, card, input, legend, radio, select, tagPill } from './ui.ts';

export interface SearchBarProps {
  text: string;
  tags: string;
  tagMode: TagMode;
  sort: SortOrder;
  /** Most-used tags, offered as one-click shortcuts. */
  popularTags: { tag: string; count: number }[];
  /**
   * Whether anything at all is applied — including a sort, which filters nothing
   * but is still remembered, and so still needs a way back out.
   */
  hasQuery: boolean;
}

export const SearchBar: FC<SearchBarProps> = ({ text, tags, tagMode, sort, popularTags, hasQuery }) => (
  <div class={card}>
    <div class="card-body">
      {/* GET so a search is a shareable, bookmarkable URL. */}
      <form method="get" action="/maps">
        <div class="grid gap-x-4 sm:grid-cols-2">
          <fieldset class="fieldset">
            <label for="q" class={legend}>
              Name
            </label>
            <input id="q" name="q" type="search" value={text} placeholder="river crossing" class={input} />
          </fieldset>

          <fieldset class="fieldset">
            <label for="tags" class={legend}>
              Tags
            </label>
            <input id="tags" name="tags" type="search" value={tags} placeholder="forest road" class={input} />
          </fieldset>
        </div>

        <div class="flex flex-wrap items-end gap-x-6 gap-y-2">
          <fieldset class="fieldset">
            <legend class={legend}>Match tags</legend>
            <div class="flex h-10 items-center gap-4">
              <label class="label">
                <input type="radio" name="mode" value="any" checked={tagMode === 'any'} class={radio} />
                Any
              </label>
              <label class="label">
                <input type="radio" name="mode" value="all" checked={tagMode === 'all'} class={radio} />
                All
              </label>
            </div>
          </fieldset>

          <fieldset class="fieldset">
            <label for="sort" class={legend}>
              Sort by
            </label>
            <select id="sort" name="sort" class={select}>
              <option value="newest" selected={sort === 'newest'}>
                Newest first
              </option>
              <option value="oldest" selected={sort === 'oldest'}>
                Oldest first
              </option>
              <option value="name" selected={sort === 'name'}>
                Name
              </option>
            </select>
          </fieldset>

          <div class="ml-auto flex items-center gap-2 py-1">
            <button type="submit" class={button.primary}>
              Search
            </button>
            {hasQuery && (
              // `clear` rather than a bare /maps, which would only restore the
              // search this is meant to be getting rid of.
              <a href="/maps?clear=1" class={button.secondary}>
                Clear
              </a>
            )}
          </div>
        </div>
      </form>

      {popularTags.length > 0 && (
        <>
          <div class="divider my-1" />
          <p class="text-xs font-medium text-base-content/60">Popular tags</p>
          <div class="flex flex-wrap gap-1.5">
            {popularTags.map(({ tag, count }) => (
              <a href={`/maps?tags=${encodeURIComponent(tag)}`} class={tagPill}>
                {tag}
                <span class="opacity-60">{count}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  </div>
);
