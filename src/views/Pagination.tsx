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

const linkClass = 'join-item btn btn-sm min-w-9';

const currentClass = 'join-item btn btn-sm btn-active min-w-9';

export const Pagination: FC<PaginationProps> = ({ page, totalPages, total, query }) => {
  if (totalPages <= 1) {
    return (
      <p class="mt-8 text-sm text-base-content/60">
        {total} map{total === 1 ? '' : 's'}.
      </p>
    );
  }

  return (
    <nav class="mt-8 flex flex-wrap items-center justify-between gap-4" aria-label="Pagination">
      <p class="text-sm text-base-content/60">
        Page {page} of {totalPages} · {total} map{total === 1 ? '' : 's'}
      </p>

      <div class="join">
        {page > 1 && (
          <a href={hrefFor(query, page - 1)} class={linkClass} rel="prev">
            Previous
          </a>
        )}

        {pageWindow(page, totalPages).map((entry) =>
          entry === 'gap' ? (
            <span class="join-item btn btn-sm btn-disabled" aria-hidden="true">
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
