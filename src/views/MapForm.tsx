/** Shared upload / edit form for map metadata. */
import type { FC } from 'hono/jsx';

import { config } from '../config.ts';
import { FORMAT_LABELS } from '../images/process.ts';
import { CsrfInput } from './Layout.tsx';
import {
  button,
  card,
  checkbox,
  checkboxLabel,
  dropZone,
  dropZoneActive,
  fieldError,
  hint,
  input,
  inputInvalid,
  label,
} from './ui.ts';

export interface MapFormValues {
  name: string;
  variant: string;
  tags: string;
  gridSize: string;
  gridWidth: string;
  gridHeight: string;
}

export type MapFormMode = 'create' | 'edit' | 'confirm';

/**
 * How this install stores an upload, in a phrase — "lossless WEBP", "PNG",
 * "JPEG at quality 82".
 *
 * The settings are an operator's choice and they change what happens to the
 * admin's file, so the form says which one is in force rather than repeating a
 * claim about WEBP that may not be true here.
 */
export function storageDescription(): string {
  const { format, quality, lossless } = config.image;
  const label = FORMAT_LABELS[format];

  // PNG is lossless whatever IMAGE_LOSSLESS says, and quality below 100 only
  // means palette quantisation — worth naming as what it is.
  if (format === 'png') return quality < 100 ? `PNG, palette-reduced to quality ${quality}` : 'lossless PNG';
  if (lossless) return `lossless ${label}`;
  return quality === 100 ? `${label} at quality 100` : `${label} at quality ${quality}`;
}

/**
 * An upload that has been processed and written but not yet committed to a map,
 * because its fingerprint matched something already in the library.
 */
export interface StagedUpload {
  uuid: string;
  imageWidth: number;
  imageHeight: number;
  gridSize: number | null;
  gridWidth: number | null;
  gridHeight: number | null;
}

export interface MapFormProps {
  mode: MapFormMode;
  action: string;
  csrfToken: string;
  values: MapFormValues;
  errors?: Record<string, string> | undefined;
  /** On edit, shows the current image and its measured dimensions. */
  existing?: { uuid: string; imageWidth: number; imageHeight: number; gridSource: string } | undefined;
  /** On confirm, the staged upload the form will commit. */
  staged?: StagedUpload | undefined;
}

const Field: FC<{
  name: string;
  labelText: string;
  value: string;
  error?: string | undefined;
  hintText?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: string;
}> = ({ name, labelText, value, error, hintText, type = 'text', required, placeholder, min }) => (
  <div>
    <label for={name} class={label}>
      {labelText}
      {required && <span class="ml-0.5 text-red-600 dark:text-red-400"> *</span>}
    </label>
    <input
      id={name}
      name={name}
      type={type}
      value={value}
      required={required}
      placeholder={placeholder}
      min={min}
      inputmode={type === 'number' ? 'numeric' : undefined}
      aria-describedby={hintText ? `${name}-hint` : undefined}
      aria-invalid={error ? 'true' : undefined}
      class={`mt-1 ${error ? inputInvalid : input}`}
    />
    {hintText && (
      <p id={`${name}-hint`} class={hint}>
        {hintText}
      </p>
    )}
    {error && <p class={fieldError}>{error}</p>}
  </div>
);

/** Names the form, so controls rendered elsewhere on the page can submit it. */
export const FORM_ID = 'map-form';

/**
 * The opt-out for looking up a higher-resolution copy of the upload.
 *
 * Ticked by default, because the search is nearly always what an admin wants
 * and because an unticked box submits nothing at all — the server reads the
 * absence, which makes "on" the state that needs no explaining.
 *
 * Absent entirely when no provider is configured. A toggle for a feature that
 * cannot run is worse than no toggle: it implies the search is happening.
 *
 * The hint says what unticking actually prevents. The search works by handing
 * the provider an address it can fetch the image from, which is the one moment
 * this app shows a full-resolution map to something that is not a signed-in
 * user, and an admin deciding whether to allow it deserves to know that without
 * having to go and read the documentation.
 */
const SearchWebField: FC = () =>
  config.webSearch.provider === 'none' ? null : (
    <div class="mt-4 flex items-start gap-3">
      <input id="searchWeb" name="searchWeb" type="checkbox" value="1" checked class={checkbox} />
      <div>
        <label for="searchWeb" class={checkboxLabel}>
          Look for a higher-resolution copy on the web
        </label>
        <p class={hint}>
          The image is briefly made readable at an unguessable address so the search can see it. Untick this and it
          is never shared, and the map is saved as uploaded.
        </p>
      </div>
    </div>
  );

/** The grid the staged image was already processed against; not editable here. */
const StagedGrid: FC<{ staged: StagedUpload }> = ({ staged }) =>
  staged.gridSize === null ? (
    <p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
      No grid was recorded for this image. You can add one after saving.
    </p>
  ) : (
    <p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
      {staged.gridSize} px per square, {staged.gridWidth} across × {staged.gridHeight} down. The image has already
      been processed to fit those squares, so the grid is edited from the map itself once this is saved.
    </p>
  );

export const MapForm: FC<MapFormProps> = ({ mode, action, csrfToken, values, errors = {}, existing, staged }) => (
  // The id lets a submit button sit outside this form and still belong to it —
  // the review page's "use this one" buttons live up in their own panel, but
  // have to carry everything typed down here along with them.
  <form id={FORM_ID} method="post" action={action} enctype="multipart/form-data" class="space-y-8">
    <CsrfInput token={csrfToken} />
    {/* Names the staged upload this submission commits. Server-side it is only
        honoured for the admin who staged it, and only until it ages out. */}
    {staged && <input type="hidden" name="pendingUuid" value={staged.uuid} />}

    <div class={`p-6 ${card}`}>
      <h2 class="text-lg font-semibold">Image</h2>

      {mode === 'confirm' && staged ? (
        <div class="mt-4 flex flex-wrap items-center gap-4">
          <img
            src={`/i/pending/${staged.uuid}/thumb`}
            alt="The image you are uploading"
            width="120"
            height="120"
            class="rounded-lg border border-stone-200 object-contain dark:border-stone-700"
          />
          <div class="text-sm text-stone-600 dark:text-stone-400">
            <p>
              {staged.imageWidth} × {staged.imageHeight} pixels
            </p>
            <p class="mt-1">
              This file has been processed and is waiting to be saved. Nothing has joined the library yet.
            </p>
          </div>
        </div>
      ) : mode === 'create' ? (
        <div class="mt-4">
          <label for="image" class={label}>
            Map file <span class="text-red-600 dark:text-red-400">*</span>
          </label>
          {/* `data-dropzone` marks the drop target for public/app.js, which
              hands anything dropped here to the file input below so the
              ordinary form submission carries it. With JavaScript off this is
              just a box around the file button, which still works. */}
          <div data-dropzone data-dropzone-active={dropZoneActive} class={`mt-1 ${dropZone}`}>
            {/* `data-name-from-file` is what public/app.js looks for, so it can
                fill the name field in as soon as a file is chosen. */}
            <input
              id="image"
              name="image"
              type="file"
              required
              data-name-from-file
              accept="image/png,image/jpeg,image/webp"
              aria-describedby="image-hint"
              aria-invalid={errors['image'] ? 'true' : undefined}
              class="block w-full text-sm text-stone-600 file:mr-4 file:rounded-lg file:border-0 file:bg-amber-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-amber-500 dark:text-stone-400 dark:file:bg-amber-500 dark:file:text-stone-950"
            />
            <p id="image-hint" class={hint}>
              PNG, JPG, or WEBP, up to {Math.floor(config.maxUploadBytes / (1024 * 1024))} MB — choose one, or drag it
              onto this box. Stored as {storageDescription()}.
            </p>
            {/* Filled in by app.js when a drop cannot be used; empty otherwise. */}
            <p data-dropzone-message role="status" class={fieldError} />
          </div>
          {errors['image'] && <p class={fieldError}>{errors['image']}</p>}
          <SearchWebField />
        </div>
      ) : (
        existing && (
          <div class="mt-4 flex flex-wrap items-center gap-4">
            <img
              src={`/i/${existing.uuid}/thumb`}
              alt=""
              width="120"
              height="120"
              class="rounded-lg border border-stone-200 object-contain dark:border-stone-700"
            />
            <div class="text-sm text-stone-600 dark:text-stone-400">
              <p>
                {existing.imageWidth} × {existing.imageHeight} pixels
              </p>
              <p class="mt-1">
                This image cannot be swapped for a different one — delete the map and upload again for that. Changing
                the square counts below may enlarge it slightly.
              </p>
            </div>
          </div>
        )
      )}
    </div>

    <div class={`p-6 ${card}`}>
      <h2 class="text-lg font-semibold">Details</h2>
      <div class="mt-4 grid gap-5 sm:grid-cols-2">
        <Field
          name="name"
          labelText="Name"
          value={values.name}
          error={errors['name']}
          // On upload a blank name is filled in from the file's own name, so
          // the browser must not block the submission over it.
          required={mode !== 'create'}
          placeholder="River Crossing"
          hintText={
            mode === 'create'
              ? "The map's name. Variants of one map share a name. Leave it blank to use the file's name."
              : "The map's name. Variants of one map share a name."
          }
        />
        <Field
          name="variant"
          labelText="Variant"
          value={values.variant}
          error={errors['variant']}
          placeholder="night"
          hintText="Leave blank unless you expect to upload multiple variants of the same map, e.g. day / night / flooded."
        />
      </div>

      <div class="mt-5">
        <Field
          name="tags"
          labelText="Tags"
          value={values.tags}
          error={errors['tags']}
          placeholder="forest road camp"
          hintText={
            mode === 'confirm'
              ? 'Copied from the map this matched, so its variants stay findable together. Edit or clear them as you like. Tags may be letters only, separated by spaces or commas.'
              : 'Tags may be letters only. Separate multiple tags by spaces or commas.'
          }
        />
      </div>
    </div>

    {mode === 'confirm' && staged ? (
      <div class={`p-6 ${card}`}>
        <h2 class="text-lg font-semibold">Grid</h2>
        <StagedGrid staged={staged} />
      </div>
    ) : (
    <div class={`p-6 ${card}`}>
      <h2 class="text-lg font-semibold">Grid</h2>
      <p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
        If the map has a painted grid, record its geometry here. Enter the grid size and the number of squares is
        worked out for you, or enter a square count and the size is derived. A square count that does not divide the
        image evenly enlarges it just enough that it does — 30 squares across a 1000px map gives 34px squares and a
        1020px image.
      </p>

      <div class="mt-4 grid gap-5 sm:grid-cols-3">
        <Field
          name="gridSize"
          labelText="Grid size"
          value={values.gridSize}
          error={errors['gridSize']}
          type="number"
          min="1"
          placeholder="70"
          hintText="Pixels per square."
        />
        <Field
          name="gridWidth"
          labelText="Grid width"
          value={values.gridWidth}
          error={errors['gridWidth']}
          type="number"
          min="1"
          placeholder="30"
          hintText="Squares across."
        />
        <Field
          name="gridHeight"
          labelText="Grid height"
          value={values.gridHeight}
          error={errors['gridHeight']}
          type="number"
          min="1"
          placeholder="20"
          hintText="Squares down."
        />
      </div>

      <p class={`mt-4 ${hint}`}>
        Leave these blank if the map has no grid. Automatic grid detection is not available yet, so blank values stay
        blank until you fill them in
        {mode === 'create'
          ? ' — though square counts in the file name are read as a starting point, so “Forest Road 40x30.png” arrives with 40 across and 30 down.'
          : '.'}
      </p>
    </div>
    )}

    <div class="flex items-center gap-3">
      <button type="submit" class={button.primary}>
        {mode === 'edit' ? 'Save changes' : mode === 'confirm' ? 'Save this map' : 'Upload map'}
      </button>
      {mode === 'confirm' ? (
        // `formnovalidate` so discarding is not blocked by the required name
        // field, which the admin has no reason to fill in on the way out.
        <button type="submit" name="action" value="discard" formnovalidate class={button.danger}>
          Discard this upload
        </button>
      ) : (
        <a href={existing ? `/maps/${existing.uuid}` : '/maps'} class={button.secondary}>
          Cancel
        </a>
      )}
    </div>
  </form>
);
