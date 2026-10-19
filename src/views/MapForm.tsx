/** Shared upload / edit form for map metadata. */
import type { FC, PropsWithChildren } from 'hono/jsx';

import { config } from '../config.ts';
import { FORMAT_LABELS } from '../images/process.ts';
import { CsrfInput } from './Layout.tsx';
import {
  button,
  card,
  checkbox,
  dropZone,
  dropZoneActive,
  fieldError,
  fileInput,
  hint,
  input,
  inputInvalid,
  legend,
  muted,
} from './ui.ts';

export interface MapFormValues {
  name: string;
  variant: string;
  tags: string;
  /** The address an upload was pasted in as, on the create form only. */
  imageUrl: string;
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
  <fieldset class="fieldset">
    <label for={name} class={legend}>
      <span>
        {labelText}
        {required && <span class="text-error"> *</span>}
      </span>
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
      class={error ? inputInvalid : input}
    />
    {hintText && (
      <p id={`${name}-hint`} class={hint}>
        {hintText}
      </p>
    )}
    {error && <p class={fieldError}>{error}</p>}
  </fieldset>
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
    <fieldset class="fieldset mt-2">
      <label for="searchWeb" class="label whitespace-normal text-sm text-base-content">
        <input id="searchWeb" name="searchWeb" type="checkbox" value="1" checked class={checkbox} />
        Look for a higher-resolution copy on the web
      </label>
      <p class={hint}>
        The image is briefly made readable at an unguessable address so the search can see it. Untick this and it is
        never shared, and the map is saved as uploaded.
      </p>
    </fieldset>
  );

/**
 * The other way to give the form an image: an address to fetch one from.
 *
 * Deliberately below the drop zone rather than beside it. The file is the usual
 * way in and stays where it has always been; this is the alternative, and the
 * divider says so in one word rather than making the layout imply it.
 *
 * `type="url"` so a phone offers the right keyboard and the browser catches an
 * address with no scheme before the round trip. `data-name-from-url` is what
 * public/app.js watches, so the name and square counts fill in from the address
 * as it is typed, exactly as they do when a file is picked.
 */
const ImageUrlField: FC<{ value: string; error?: string | undefined }> = ({ value, error }) => (
  <div>
    <div class="divider text-xs uppercase text-base-content/60" aria-hidden="true">
      or
    </div>

    <fieldset class="fieldset">
      <label for="imageUrl" class={legend}>
        Image address
      </label>
      <input
        id="imageUrl"
        name="imageUrl"
        type="url"
        value={value}
        inputmode="url"
        placeholder="https://example.com/maps/forest-road-40x30.png"
        data-name-from-url
        aria-describedby="imageUrl-hint"
        aria-invalid={error ? 'true' : undefined}
        class={error ? inputInvalid : input}
      />
      <p id="imageUrl-hint" class={hint}>
        A link straight to the image file, not to the page it appears on. It is downloaded and stored here like any
        other upload.
      </p>
      {error && <p class={fieldError}>{error}</p>}
    </fieldset>
  </div>
);

/** The grid the staged image was already processed against; not editable here. */
const StagedGrid: FC<{ staged: StagedUpload }> = ({ staged }) =>
  staged.gridSize === null ? (
    <p class={`text-sm ${muted}`}>
      No grid was recorded for this image. You can add one after saving.
    </p>
  ) : (
    <p class={`text-sm ${muted}`}>
      {staged.gridSize} px per square, {staged.gridWidth} across × {staged.gridHeight} down. The image has already
      been processed to fit those squares, so the grid is edited from the map itself once this is saved.
    </p>
  );

/** One titled block of the form, as a daisyUI card. */
const Section: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <section class={card}>
    <div class="card-body">
      <h2 class="card-title">{title}</h2>
      {children}
    </div>
  </section>
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

    {/* Side by side once there is room: the image on the left, what is
        recorded about it on the right. */}
    <div class="grid gap-8 lg:grid-cols-2 lg:items-start">
      <Section title="Image">
        {mode === 'confirm' && staged ? (
          <div class="flex flex-wrap items-center gap-4">
            <img
              src={`/i/pending/${staged.uuid}/thumb`}
              alt="The image you are uploading"
              width="120"
              height="120"
              class="rounded-field border border-base-300 object-contain"
            />
            <div class={`text-sm ${muted}`}>
              <p>
                {staged.imageWidth} × {staged.imageHeight} pixels
              </p>
              <p class="mt-1">
                This file has been processed and is waiting to be saved. Nothing has joined the library yet.
              </p>
            </div>
          </div>
        ) : mode === 'create' ? (
          <div>
            {/* Neither field is required on its own and the form needs one of
                them, which is a rule no single asterisk can state — so it is said
                once, here, and both fields are left unmarked. */}
            <p class={`text-sm ${muted}`}>
              Choose a file, paste an image, or paste the address of one.
            </p>
            <fieldset class="fieldset">
              <label for="image" class={legend}>
                Map file
              </label>
              {/* `data-dropzone` marks the drop target for public/app.js, which
                  hands anything dropped here to the file input below so the
                  ordinary form submission carries it. The paste handler is on the
                  document rather than on this box — it only looks for the box to
                  tell that this is the page with an upload on it, and for somewhere
                  to put its message. With JavaScript off this is just a box around
                  the file button, which still works. */}
              <div data-dropzone data-dropzone-active={dropZoneActive} class={dropZone}>
                {/* `data-name-from-file` is what public/app.js looks for, so it can
                    fill the name field in as soon as a file is chosen. */}
                {/* Not `required`: the address below is the other way to fill this
                    form in, and a required file input would have the browser block a
                    submission carrying one. The server rejects a submission with
                    neither, which is what that attribute used to do. */}
                <input
                  id="image"
                  name="image"
                  type="file"
                  data-name-from-file
                  accept="image/png,image/jpeg,image/webp"
                  aria-describedby="image-hint"
                  aria-invalid={errors['image'] ? 'true' : undefined}
                  class={fileInput}
                />
                <p id="image-hint" class={hint}>
                  PNG, JPG, or WEBP, up to {Math.floor(config.maxUploadBytes / (1024 * 1024))} MB — choose one, drag it
                  onto this box, or paste one from the clipboard. Stored as {storageDescription()}.
                </p>
                {/* Filled in by app.js when a drop or a paste cannot be used; empty
                    otherwise. */}
                <p data-dropzone-message role="status" class={fieldError} />
              </div>
              {errors['image'] && <p class={fieldError}>{errors['image']}</p>}
            </fieldset>
            <ImageUrlField value={values.imageUrl} error={errors['imageUrl']} />
            <SearchWebField />
          </div>
        ) : (
          existing && (
            <div class="flex flex-wrap items-center gap-4">
              <img
                src={`/i/${existing.uuid}/thumb`}
                alt=""
                width="120"
                height="120"
                class="rounded-field border border-base-300 object-contain"
              />
              <div class={`text-sm ${muted}`}>
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
      </Section>

      <div class="space-y-8">
        <Section title="Details">
          <div class="grid gap-x-5 sm:grid-cols-2">
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

          <div>
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
        </Section>

        {mode === 'confirm' && staged ? (
          <Section title="Grid">
            <StagedGrid staged={staged} />
          </Section>
        ) : (
        <Section title="Grid">
          <p class={`text-sm ${muted}`}>
            If the map has a painted grid, record its geometry here. Enter the grid size and the number of squares is
            worked out for you, or enter a square count and the size is derived. A square count that does not divide the
            image evenly enlarges it just enough that it does — 30 squares across a 1000px map gives 34px squares and a
            1020px image.
          </p>

          <div class="grid gap-x-5 sm:grid-cols-3">
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

          <p class={hint}>
            Leave these blank if the map has no grid
            {mode === 'create'
              ? ' — or if it has one and you would rather it were measured for you, which happens on upload when all three are empty. Square counts in the file name are read as a starting point and take precedence, so “Forest Road 40x30.png” arrives with 40 across and 30 down.'
              : '. Blank values stay blank on an edit; a grid is only measured when the image is first uploaded.'}
          </p>
        </Section>
        )}
      </div>
    </div>

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
