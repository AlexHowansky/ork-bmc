/**
 * Administrator routes: upload, edit, delete.
 *
 * Every route here is mounted behind `requireAdmin`, so a viewer receives a 403
 * even if they discover the URL — hiding the buttons is presentation, not
 * access control.
 */
import { Hono, type Context } from 'hono';

import { requireAdmin } from '../auth/middleware.ts';
import { badRequest, notFound, validationFailed } from '../errors.ts';
import { processUpload } from '../images/process.ts';
import { resolveGrid } from '../images/grid.ts';
import { deleteImage } from '../images/storage.ts';
import {
  assertTagsAcceptable,
  createMap,
  deleteMap,
  findMap,
  parseTagInput,
  updateMap,
  type MapRecord,
} from '../models/maps.ts';
import type { AppEnv } from '../types.ts';
import { MapForm, type MapFormValues } from '../views/MapForm.tsx';
import { page, setFlash } from '../views/render.tsx';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('/maps/new', requireAdmin());
adminRoutes.use('/maps/:uuid/edit', requireAdmin());
adminRoutes.use('/maps/:uuid/delete', requireAdmin());

const MAX_NAME_LENGTH = 200;
const MAX_VARIANT_LENGTH = 100;

const emptyValues = (): MapFormValues => ({
  name: '',
  variant: '',
  tags: '',
  gridSize: '',
  gridWidth: '',
  gridHeight: '',
});

const valuesFromMap = (map: MapRecord): MapFormValues => ({
  name: map.name,
  variant: map.variant,
  tags: map.tags.join(' '),
  gridSize: map.gridSize?.toString() ?? '',
  gridWidth: map.gridWidth?.toString() ?? '',
  gridHeight: map.gridHeight?.toString() ?? '',
});

const field = (body: Record<string, unknown>, key: string): string =>
  typeof body[key] === 'string' ? (body[key] as string).trim() : '';

/**
 * Parses an optional positive integer field.
 * Collects errors rather than throwing so the form can report every problem at
 * once instead of one per submission.
 */
function optionalPositiveInt(
  raw: string,
  fieldName: string,
  errors: Record<string, string>,
): number | undefined {
  if (raw === '') return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    errors[fieldName] = 'Enter a whole number of 1 or more, or leave this blank.';
    return undefined;
  }
  if (value > 100_000) {
    errors[fieldName] = 'That value is unrealistically large.';
    return undefined;
  }
  return value;
}

interface ParsedForm {
  name: string;
  variant: string;
  tags: string[];
  gridSize: number | undefined;
  gridWidth: number | undefined;
  gridHeight: number | undefined;
}

function parseMapForm(body: Record<string, unknown>): { values: MapFormValues; parsed: ParsedForm } {
  const values: MapFormValues = {
    name: field(body, 'name'),
    variant: field(body, 'variant'),
    tags: field(body, 'tags'),
    gridSize: field(body, 'gridSize'),
    gridWidth: field(body, 'gridWidth'),
    gridHeight: field(body, 'gridHeight'),
  };

  const errors: Record<string, string> = {};

  if (values.name === '') {
    errors['name'] = 'Please give the map a name.';
  } else if (values.name.length > MAX_NAME_LENGTH) {
    errors['name'] = `Please keep the name under ${MAX_NAME_LENGTH} characters.`;
  }

  if (values.variant.length > MAX_VARIANT_LENGTH) {
    errors['variant'] = `Please keep the variant under ${MAX_VARIANT_LENGTH} characters.`;
  }

  const gridSize = optionalPositiveInt(values.gridSize, 'gridSize', errors);
  const gridWidth = optionalPositiveInt(values.gridWidth, 'gridWidth', errors);
  const gridHeight = optionalPositiveInt(values.gridHeight, 'gridHeight', errors);

  const { tags, rejected } = parseTagInput(values.tags);

  if (Object.keys(errors).length > 0) {
    throw validationFailed(errors);
  }
  assertTagsAcceptable(rejected, tags.length);

  return { values, parsed: { name: values.name, variant: values.variant, tags, gridSize, gridWidth, gridHeight } };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

adminRoutes.get('/maps/new', (c) =>
  page(
    c,
    { title: 'Upload a map' },
    <div class="mx-auto max-w-3xl">
      <h1 class="text-2xl font-bold tracking-tight">Upload a map</h1>
      <p class="mt-2 text-sm text-stone-600 dark:text-stone-400">
        The image is converted to lossless WEBP and stored under a new identifier.
      </p>
      <div class="mt-8">
        <MapForm mode="create" action="/maps/new" csrfToken={c.get('csrfToken')} values={emptyValues()} />
      </div>
    </div>,
  ),
);

adminRoutes.post('/maps/new', async (c) => {
  const body = await c.req.parseBody();
  const logger = c.get('logger');
  const user = c.get('user')!;

  let values = emptyValues();

  try {
    const parsedForm = parseMapForm(body);
    values = parsedForm.values;
    const { parsed } = parsedForm;

    const file = body['image'];
    if (!(file instanceof File) || file.size === 0) {
      throw validationFailed({ image: 'Please choose an image file to upload.' });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const processed = await processUpload(bytes, {
      grid: { gridSize: parsed.gridSize, gridWidth: parsed.gridWidth, gridHeight: parsed.gridHeight },
    });

    try {
      const map = createMap({
        uuid: processed.uuid,
        name: parsed.name,
        variant: parsed.variant,
        tags: parsed.tags,
        gridSize: processed.grid.gridSize,
        gridWidth: processed.grid.gridWidth,
        gridHeight: processed.grid.gridHeight,
        gridSource: processed.grid.source,
        upscaleFactor: processed.grid.upscaleFactor,
        imageWidth: processed.imageWidth,
        imageHeight: processed.imageHeight,
        fileSize: processed.fileSize,
        originalFilename: file.name.slice(0, 255) || null,
        uploadedBy: user.id,
      });

      logger.info('map created', { uuid: map.uuid, name: map.name, variant: map.variant });
      setFlash(c, {
        kind: 'success',
        message:
          processed.grid.source === 'none'
            ? `“${map.name}” was uploaded. No grid was recorded — edit the map to add one.`
            : `“${map.name}” was uploaded.`,
      });

      return c.redirect(`/maps/${map.uuid}`, 302);
    } catch (error) {
      // The row was rejected (almost always a duplicate name/variant), so the
      // files just written would otherwise be orphaned on disk.
      await deleteImage(processed.uuid);
      throw error;
    }
  } catch (error) {
    return renderFormError(c, error, 'create', '/maps/new', values);
  }
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

function requireMap(uuid: string): MapRecord {
  const map = findMap(uuid);
  if (!map) throw notFound('That map does not exist.');
  return map;
}

adminRoutes.get('/maps/:uuid/edit', (c) => {
  const map = requireMap(c.req.param('uuid'));

  return page(
    c,
    { title: `Edit ${map.name}` },
    <div class="mx-auto max-w-3xl">
      <h1 class="text-2xl font-bold tracking-tight">Edit “{map.name}”</h1>
      <div class="mt-8">
        <MapForm
          mode="edit"
          action={`/maps/${map.uuid}/edit`}
          csrfToken={c.get('csrfToken')}
          values={valuesFromMap(map)}
          existing={{
            uuid: map.uuid,
            imageWidth: map.imageWidth,
            imageHeight: map.imageHeight,
            gridSource: map.gridSource,
          }}
        />
      </div>
    </div>,
  );
});

adminRoutes.post('/maps/:uuid/edit', async (c) => {
  const map = requireMap(c.req.param('uuid'));
  const body = await c.req.parseBody();

  let values = valuesFromMap(map);

  try {
    const parsedForm = parseMapForm(body);
    values = parsedForm.values;
    const { parsed } = parsedForm;

    // Re-derive so that filling in just a grid size still yields the square
    // counts, exactly as it does on upload.
    const grid = resolveGrid(
      { gridSize: parsed.gridSize, gridWidth: parsed.gridWidth, gridHeight: parsed.gridHeight },
      { width: map.imageWidth, height: map.imageHeight },
    );

    const updated = updateMap(map.uuid, {
      name: parsed.name,
      variant: parsed.variant,
      tags: parsed.tags,
      gridSize: grid.gridSize,
      gridWidth: grid.gridWidth,
      gridHeight: grid.gridHeight,
      gridSource: grid.source,
      upscaleFactor: map.upscaleFactor,
    });

    c.get('logger').info('map updated', { uuid: updated.uuid, name: updated.name });
    setFlash(c, { kind: 'success', message: `“${updated.name}” was saved.` });

    return c.redirect(`/maps/${updated.uuid}`, 302);
  } catch (error) {
    return renderFormError(c, error, 'edit', `/maps/${map.uuid}/edit`, values, map);
  }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

adminRoutes.post('/maps/:uuid/delete', async (c) => {
  const map = requireMap(c.req.param('uuid'));

  // Row first: if unlinking fails the map is already gone from the UI, and a
  // stray file is a smaller problem than a listing entry with no image.
  deleteMap(map.uuid);
  await deleteImage(map.uuid);

  c.get('logger').info('map deleted', { uuid: map.uuid, name: map.name });
  setFlash(c, { kind: 'success', message: `“${map.name}” was deleted.` });

  return c.redirect('/maps', 302);
});

/**
 * Re-renders the form with the submitted values and per-field messages, so a
 * rejected submission never costs the admin their typing.
 */
function renderFormError(
  c: Context<AppEnv>,
  error: unknown,
  mode: 'create' | 'edit',
  action: string,
  values: MapFormValues,
  map?: MapRecord,
): Response {
  const isFieldError =
    error !== null && typeof error === 'object' && 'fields' in error && (error as { fields?: unknown }).fields;

  if (!isFieldError) throw error;

  const appError = error as { userMessage: string; status: number; fields: Record<string, string> };
  c.get('logger').warn('map form rejected', { fields: Object.keys(appError.fields) });

  return page(
    c,
    { title: mode === 'create' ? 'Upload a map' : 'Edit map', status: appError.status },
    <div class="mx-auto max-w-3xl">
      <h1 class="text-2xl font-bold tracking-tight">{mode === 'create' ? 'Upload a map' : `Edit “${map?.name}”`}</h1>
      <div
        role="alert"
        class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
      >
        {appError.userMessage}
      </div>
      <div class="mt-8">
        <MapForm
          mode={mode}
          action={action}
          csrfToken={c.get('csrfToken')}
          values={values}
          errors={appError.fields}
          existing={
            map
              ? {
                  uuid: map.uuid,
                  imageWidth: map.imageWidth,
                  imageHeight: map.imageHeight,
                  gridSource: map.gridSource,
                }
              : undefined
          }
        />
      </div>
    </div>,
  );
}

export { badRequest };
