/** Pagination that preserves the current search across page changes. */
import type { FC } from 'hono/jsx';

export interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  /** Current query parameters, minus `page`. */
  query: Record<string, string>;
}

function hrefFor(query: Record<string, string>, page: number): string {
  const params = new URLSearchParams(query);
  if (page > 1) params.set('page', String(page));
  const search = params.toString();
  return search ? `/maps?${search}` : '/maps';
}

/** Page numbers to show: always the first, last, and a window around the current one. */
function pageWindow(page: number, totalPages: number): (number | 'gap')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

  const pages = new Set([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  const result: (number | 'gap')[] = [];
  let previous = 0;
  for (const current of sorted) {
    if (previous && current - previous > 1) result.push('gap');
    result.push(current);
    previous = current;
  }
  return result;
}

const linkClass =
  'inline-flex min-w-9 items-center justify-center rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm ' +
  'font-medium text-stone-700 transition hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-amber-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700';

const currentClass =
  'inline-flex min-w-9 items-center justify-center rounded-lg border border-amber-600 bg-amber-600 px-3 py-2 ' +
  'text-sm font-semibold text-white dark:border-amber-500 dark:bg-amber-500 dark:text-stone-950';

export const Pagination: FC<PaginationProps> = ({ page, totalPages, total, query }) => {
  if (totalPages <= 1) {
    return (
      <p class="mt-8 text-sm text-stone-500 dark:text-stone-400">
        {total} map{total === 1 ? '' : 's'}.
      </p>
    );
  }

  return (
    <nav class="mt-8 flex flex-wrap items-center justify-between gap-4" aria-label="Pagination">
      <p class="text-sm text-stone-500 dark:text-stone-400">
        Page {page} of {totalPages} · {total} map{total === 1 ? '' : 's'}
      </p>

      <div class="flex flex-wrap items-center gap-1">
        {page > 1 && (
          <a href={hrefFor(query, page - 1)} class={linkClass} rel="prev">
            Previous
          </a>
        )}

        {pageWindow(page, totalPages).map((entry) =>
          entry === 'gap' ? (
            <span class="px-2 text-stone-400 dark:text-stone-600" aria-hidden="true">
              …
            </span>
          ) : (
            <a
              href={hrefFor(query, entry)}
              class={entry === page ? currentClass : linkClass}
              aria-current={entry === page ? 'page' : undefined}
              aria-label={`Page ${entry}`}
            >
              {entry}
            </a>
          ),
        )}

        {page < totalPages && (
          <a href={hrefFor(query, page + 1)} class={linkClass} rel="next">
            Next
          </a>
        )}
      </div>
    </nav>
  );
};
