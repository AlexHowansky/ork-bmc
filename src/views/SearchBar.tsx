/** Search controls: name text, tags, AND/OR mode, and sort order. */
import type { FC } from 'hono/jsx';

import type { SortOrder, TagMode } from '../models/maps.ts';
import { button, card, input, label, tagPill } from './ui.ts';

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

const radioClass =
  'h-4 w-4 border-stone-300 text-amber-600 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-amber-600 dark:border-stone-600';

export const SearchBar: FC<SearchBarProps> = ({ text, tags, tagMode, sort, popularTags, hasQuery }) => (
  <div class={`p-4 sm:p-6 ${card}`}>
    {/* GET so a search is a shareable, bookmarkable URL. */}
    <form method="get" action="/maps" class="space-y-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label for="q" class={label}>
            Name
          </label>
          <input
            id="q"
            name="q"
            type="search"
            value={text}
            placeholder="river crossing"
            class={`mt-1 ${input}`}
          />
        </div>

        <div>
          <label for="tags" class={label}>
            Tags
          </label>
          <input
            id="tags"
            name="tags"
            type="search"
            value={tags}
            placeholder="forest road"
            class={`mt-1 ${input}`}
          />
        </div>
      </div>

      <div class="flex flex-wrap items-end gap-6">
        <fieldset>
          <legend class={label}>Match tags</legend>
          <div class="mt-2 flex items-center gap-4">
            <label class="flex items-center gap-2 text-sm">
              <input type="radio" name="mode" value="any" checked={tagMode === 'any'} class={radioClass} />
              Any
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input type="radio" name="mode" value="all" checked={tagMode === 'all'} class={radioClass} />
              All
            </label>
          </div>
        </fieldset>

        <div>
          <label for="sort" class={label}>
            Sort by
          </label>
          <select id="sort" name="sort" class={`mt-1 ${input}`}>
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
        </div>

        <div class="ml-auto flex items-center gap-2">
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
      <div class="mt-5 border-t border-stone-200 pt-4 dark:border-stone-800">
        <p class="text-xs font-medium text-stone-500 dark:text-stone-400">Popular tags</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          {popularTags.map(({ tag, count }) => (
            <a
              href={`/maps?tags=${encodeURIComponent(tag)}`}
              class={`${tagPill} transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600`}
            >
              {tag}
              <span class="ml-1 opacity-60">{count}</span>
            </a>
          ))}
        </div>
      </div>
    )}
  </div>
);
