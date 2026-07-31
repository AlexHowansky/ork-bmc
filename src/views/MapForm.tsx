/** Shared upload / edit form for map metadata. */
import type { FC } from 'hono/jsx';

import { config } from '../config.ts';
import { CsrfInput } from './Layout.tsx';
import { button, card, fieldError, hint, input, inputInvalid, label } from './ui.ts';

export interface MapFormValues {
  name: string;
  variant: string;
  tags: string;
  gridSize: string;
  gridWidth: string;
  gridHeight: string;
}

export interface MapFormProps {
  mode: 'create' | 'edit';
  action: string;
  csrfToken: string;
  values: MapFormValues;
  errors?: Record<string, string> | undefined;
  /** On edit, shows the current image and its measured dimensions. */
  existing?: { uuid: string; imageWidth: number; imageHeight: number; gridSource: string } | undefined;
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

export const MapForm: FC<MapFormProps> = ({ mode, action, csrfToken, values, errors = {}, existing }) => (
  <form method="post" action={action} enctype="multipart/form-data" class="space-y-8">
    <CsrfInput token={csrfToken} />

    <div class={`p-6 ${card}`}>
      <h2 class="text-lg font-semibold">Image</h2>

      {mode === 'create' ? (
        <div class="mt-4">
          <label for="image" class={label}>
            Map file <span class="text-red-600 dark:text-red-400">*</span>
          </label>
          <input
            id="image"
            name="image"
            type="file"
            required
            accept="image/png,image/jpeg,image/webp"
            aria-describedby="image-hint"
            aria-invalid={errors['image'] ? 'true' : undefined}
            class="mt-1 block w-full text-sm text-stone-600 file:mr-4 file:rounded-lg file:border-0 file:bg-amber-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-amber-500 dark:text-stone-400 dark:file:bg-amber-500 dark:file:text-stone-950"
          />
          <p id="image-hint" class={hint}>
            PNG, JPG, or WEBP, up to {Math.floor(config.maxUploadBytes / (1024 * 1024))} MB. Stored as lossless WEBP,
            so no quality is lost.
          </p>
          {errors['image'] && <p class={fieldError}>{errors['image']}</p>}
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
              <p class="mt-1">The image itself cannot be changed. Delete this map and upload again to replace it.</p>
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
          required
          placeholder="River Crossing"
          hintText="The map's name. Variants of one map share a name."
        />
        <Field
          name="variant"
          labelText="Variant"
          value={values.variant}
          error={errors['variant']}
          placeholder="night"
          hintText="Optional. Distinguishes versions, e.g. day / night / flooded."
        />
      </div>

      <div class="mt-5">
        <Field
          name="tags"
          labelText="Tags"
          value={values.tags}
          error={errors['tags']}
          placeholder="forest road camp"
          hintText="Separated by spaces or commas. Lowercase letters only."
        />
      </div>
    </div>

    <div class={`p-6 ${card}`}>
      <h2 class="text-lg font-semibold">Grid</h2>
      <p class="mt-1 text-sm text-stone-600 dark:text-stone-400">
        If the map has a painted grid, record its geometry here. Enter the grid size and the number of squares is
        worked out for you, or enter a square count and the size is derived.
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
        blank until you fill them in.
      </p>
    </div>

    <div class="flex items-center gap-3">
      <button type="submit" class={button.primary}>
        {mode === 'create' ? 'Upload map' : 'Save changes'}
      </button>
      <a href={existing ? `/maps/${existing.uuid}` : '/maps'} class={button.secondary}>
        Cancel
      </a>
    </div>
  </form>
);
