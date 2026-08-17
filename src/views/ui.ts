/**
 * Shared class strings.
 *
 * Kept in one place so buttons, inputs and cards stay visually consistent, and
 * so a styling change happens once rather than in a dozen templates. Every
 * token below has an explicit dark-mode counterpart.
 */

export const button = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white ' +
    'shadow-sm transition hover:bg-amber-500 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-amber-600 disabled:opacity-50 dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-stone-950',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm ' +
    'font-semibold text-stone-700 shadow-sm transition hover:bg-stone-50 focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-amber-600 dark:border-stone-700 dark:bg-stone-800 ' +
    'dark:text-stone-200 dark:hover:bg-stone-700',
  danger:
    'inline-flex items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm ' +
    'font-semibold text-red-700 shadow-sm transition hover:bg-red-50 focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-red-600 dark:border-red-900 dark:bg-stone-800 ' +
    'dark:text-red-400 dark:hover:bg-red-950',
  ghost:
    'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-stone-600 ' +
    'transition hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-amber-600 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100',
} as const;

export const input =
  'block w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm ' +
  'placeholder:text-stone-400 focus:border-amber-500 focus:outline-2 focus:outline-offset-0 focus:outline-amber-500 ' +
  'dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100 dark:placeholder:text-stone-500';

export const inputInvalid =
  'block w-full rounded-lg border border-red-400 bg-white px-3 py-2 text-sm text-stone-900 shadow-sm ' +
  'placeholder:text-stone-400 focus:border-red-500 focus:outline-2 focus:outline-offset-0 focus:outline-red-500 ' +
  'dark:border-red-800 dark:bg-stone-800 dark:text-stone-100 dark:placeholder:text-stone-500';

export const label = 'block text-sm font-medium text-stone-700 dark:text-stone-300';

/** `accent-*` colours the tick itself, so the box needs no custom rendering. */
export const checkbox =
  'mt-0.5 size-4 shrink-0 rounded border-stone-300 accent-amber-600 focus-visible:outline-2 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-amber-600 dark:border-stone-600 dark:accent-amber-500';

export const checkboxLabel = 'text-sm font-medium text-stone-700 dark:text-stone-300';

export const hint = 'mt-1 text-xs text-stone-500 dark:text-stone-400';

export const fieldError = 'mt-1 text-xs font-medium text-red-600 dark:text-red-400';

export const card =
  'rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900';

/**
 * The upload form's drop target.
 *
 * `dropZoneActive` is added by `public/app.js` while a file is dragged over the
 * box and removed again on leave or drop. It travels to the script in a data
 * attribute on the element, so the class names stay here with the rest of them
 * rather than being spelled out in JavaScript.
 */
export const dropZone =
  'rounded-xl border-2 border-dashed border-stone-300 p-4 transition dark:border-stone-700';

export const dropZoneActive =
  'border-amber-500 bg-amber-50 dark:border-amber-400 dark:bg-amber-950/30';

export const badge =
  'inline-flex items-center rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-700 ' +
  'dark:bg-stone-800 dark:text-stone-300';

export const badgeWarning =
  'inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 ' +
  'dark:bg-amber-950 dark:text-amber-300';

/**
 * The marker a thumbnail carries when its map has no known grid.
 *
 * It sits over the image, so it needs a background of its own to stay readable
 * against whatever the map happens to look like under it.
 */
export const thumbWarning =
  'absolute right-2 top-2 inline-flex items-center rounded-full bg-amber-100 p-1 text-amber-700 ' +
  'shadow-sm ring-1 ring-inset ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800';

export const tagPill =
  'inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ' +
  'ring-1 ring-inset ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900';

export const link =
  'font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-400 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 rounded-sm';
