/**
 * Shared class strings.
 *
 * Kept in one place so buttons, inputs and cards stay visually consistent, and
 * so a styling change happens once rather than in a dozen templates. The
 * components are daisyUI's and every colour is one of its semantic names, so
 * the stock light and dark themes cover them with no `dark:` counterparts.
 */

export const button = {
  primary: 'btn btn-primary',
  secondary: 'btn',
  danger: 'btn btn-outline btn-error',
  ghost: 'btn btn-ghost',
} as const;

export const input = 'input w-full';

export const inputInvalid = 'input input-error w-full';

export const select = 'select w-full';

export const checkbox = 'checkbox checkbox-sm';

export const radio = 'radio radio-sm';

export const fileInput = 'file-input w-full';

/** A field's title, on the <label> so the input keeps its accessible name. */
export const legend = 'fieldset-legend';

/** daisyUI's `label` does not wrap; a sentence of help text has to. */
export const hint = 'label whitespace-normal text-xs';

export const fieldError = 'label whitespace-normal text-xs text-error';

/** Body text that sits a step back from headings, without being a hint. */
export const muted = 'text-base-content/70';

export const card = 'card card-border bg-base-100';

/** The daisyUI alert for each kind of flash message and inline error. */
export const alert = {
  success: 'alert alert-success',
  error: 'alert alert-error',
  info: 'alert alert-info',
} as const;

/**
 * The panel the review page raises over an upload — a possible duplicate, or a
 * larger copy found on the web. A card rather than a daisyUI alert, whose grid
 * layout is built for a line of text and not for a list of maps.
 */
export const warningPanel = 'card card-border border-warning bg-base-100';

/**
 * The upload form's drop target.
 *
 * `dropZoneActive` is added by `public/app.js` while a file is dragged over the
 * box and removed again on leave or drop. It travels to the script in a data
 * attribute on the element, so the class names stay here with the rest of them
 * rather than being spelled out in JavaScript.
 */
export const dropZone = 'card card-dash border-base-content/20 gap-2 p-4 transition';

export const dropZoneActive = 'border-primary! bg-primary/10';

export const badge = 'badge badge-sm';

export const badgeWarning = 'badge badge-sm badge-warning';

/**
 * The marker a thumbnail carries when its map has no known grid.
 *
 * It sits over the image, so it needs a background of its own to stay readable
 * against whatever the map happens to look like under it.
 */
export const thumbWarning = 'badge badge-warning absolute right-2 top-2 h-auto p-1';

export const tagPill = 'badge badge-sm badge-soft badge-primary';

export const link = 'link';

/**
 * Draws a one-pixel rule at every grid line over a map image, so the recorded
 * grid can be checked against the painted one at a glance.
 *
 * The rule colour and `background-size` are deliberately absent: both come
 * from the nonce'd <style> block the detail page emits (see `gridOverlayCss`
 * in views/Layout.tsx) — the size in percentages so the overlay stays aligned
 * at whatever width the image is displayed, the colour from
 * GRID_OVERLAY_COLOR, which Tailwind cannot compile into a class. One string
 * literal, unsplit, or Tailwind's scanner will not see the class.
 */
export const gridOverlay =
  'bg-[linear-gradient(to_right,var(--grid-overlay-color)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid-overlay-color)_1px,transparent_1px)]';
