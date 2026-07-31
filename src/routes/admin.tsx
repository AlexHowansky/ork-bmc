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
import { processUpload, rescaleStored } from '../images/process.ts';
import { resolveGrid, type GridInput, type ResolvedGrid } from '../images/grid.ts';
import { deleteImage, isValidUuid, storeImage } from '../images/storage.ts';
import {
  assertTagsAcceptable,
  createMap,
  deleteMap,
  findMap,
  findSimilarMaps,
  nameFromFilename,
  parseTagInput,
  updateMap,
  MAX_NAME_LENGTH,
  type MapRecord,
  type SimilarMap,
} from '../models/maps.ts';
import {
  createPendingUpload,
  deletePendingUpload,
  findPendingUpload,
  type PendingUpload,
} from '../models/pendingUploads.ts';
import type { AppEnv } from '../types.ts';
import { DuplicateWarning } from '../views/DuplicateWarning.tsx';
import { MapForm, type MapFormMode, type MapFormValues, type StagedUpload } from '../views/MapForm.tsx';
import { page, setFlash } from '../views/render.tsx';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('/maps/new', requireAdmin());
adminRoutes.use('/maps/:uuid/edit', requireAdmin());
adminRoutes.use('/maps/:uuid/delete', requireAdmin());

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

/**
 * Reads the form back without judging it, so a caller can hold on to what was
 * submitted before validation gets a chance to throw and re-render.
 *
 * `fallbackName` stands in for a name the admin left blank — on upload it is the
 * file's own name.
 */
function formValues(body: Record<string, unknown>, fallbackName = ''): MapFormValues {
  return {
    name: field(body, 'name') || fallbackName,
    variant: field(body, 'variant'),
    tags: field(body, 'tags'),
    gridSize: field(body, 'gridSize'),
    gridWidth: field(body, 'gridWidth'),
    gridHeight: field(body, 'gridHeight'),
  };
}

function parseMapForm(
  body: Record<string, unknown>,
  fallbackName = '',
): { values: MapFormValues; parsed: ParsedForm } {
  const values = formValues(body, fallbackName);

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

/**
 * Decides which of the three grid fields the admin actually meant.
 *
 * The edit form arrives pre-filled with all three, so a submission that changes
 * only the square counts still carries the old grid size, and the two disagree
 * by construction. Whichever the admin touched wins, and the rest are dropped so
 * they are re-derived: changing the counts is a request to re-fit the image to
 * them, changing the size is a request to recount the squares.
 *
 * On upload there is nothing to compare against, so anything supplied counts as
 * a change and the counts still take precedence.
 */
function chooseGridInput(parsed: ParsedForm, previous?: MapRecord): GridInput {
  const same = (value: number | undefined, stored: number | null | undefined): boolean =>
    (value ?? null) === (stored ?? null);

  const countsChanged =
    !same(parsed.gridWidth, previous?.gridWidth) || !same(parsed.gridHeight, previous?.gridHeight);
  if (countsChanged && (parsed.gridWidth !== undefined || parsed.gridHeight !== undefined)) {
    return { gridWidth: parsed.gridWidth, gridHeight: parsed.gridHeight };
  }

  if (!same(parsed.gridSize, previous?.gridSize) && parsed.gridSize !== undefined) {
    return { gridSize: parsed.gridSize };
  }

  return { gridSize: parsed.gridSize, gridWidth: parsed.gridWidth, gridHeight: parsed.gridHeight };
}

/** Explains a resize, or the refusal to do one, in the success flash. */
function gridNote(grid: ResolvedGrid, width: number, height: number): string {
  if (grid.target) {
    return ` It was enlarged to ${width}×${height} so its ${grid.gridWidth}×${grid.gridHeight} squares land on whole pixels.`;
  }
  if (grid.capped) {
    return ` The image would have had to grow too much for those squares to divide it exactly, so the grid size was rounded to ${grid.gridSize}px.`;
  }
  return '';
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

/**
 * Handles the upload form, in either of the two states it can be submitted from.
 *
 * A first submission carries a file. If its fingerprint does not resemble
 * anything in the library — the overwhelmingly common case — the map is created
 * and this behaves exactly as it always has. If it does, the processed image is
 * staged instead and the admin is shown what it matched, so they can decide
 * whether they meant to add a variant of a map they already have.
 *
 * A second submission carries `pendingUuid` instead of a file, and either
 * commits that staged upload or throws it away.
 */
adminRoutes.post('/maps/new', async (c) => {
  const body = await c.req.parseBody();

  return typeof body['pendingUuid'] === 'string' && body['pendingUuid'] !== ''
    ? resolveStagedUpload(c, body)
    : createFromUpload(c, body);
});

async function createFromUpload(c: Context<AppEnv>, body: Record<string, unknown>): Promise<Response> {
  const logger = c.get('logger');
  const user = c.get('user')!;

  let values = emptyValues();

  try {
    // The file's name only, not its bytes: it is what an unnamed map is named
    // after, and the checks below still own rejecting a file that is not usable.
    const file = body['image'];
    const uploadedName = file instanceof File ? file.name.slice(0, 255) : '';

    const fallbackName = nameFromFilename(uploadedName);
    // Before validating, so a rejected submission comes back intact.
    values = formValues(body, fallbackName);
    const { parsed } = parseMapForm(body, fallbackName);

    if (!(file instanceof File) || file.size === 0) {
      throw validationFailed({ image: 'Please choose an image file to upload.' });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const processed = await processUpload(bytes, { grid: chooseGridInput(parsed) });
    const originalFilename = uploadedName || null;

    const matches = findSimilarMaps(processed.fingerprint);
    if (matches.length > 0) {
      // Stage rather than commit: the admin is about to be shown the matches and
      // may well want the name of one of them, which is no longer a choice once
      // the row exists.
      const pending = createPendingUpload({
        uuid: processed.uuid,
        userId: user.id,
        fingerprint: processed.fingerprint,
        gridSize: processed.grid.gridSize,
        gridWidth: processed.grid.gridWidth,
        gridHeight: processed.grid.gridHeight,
        imageWidth: processed.imageWidth,
        imageHeight: processed.imageHeight,
        fileSize: processed.fileSize,
        gridSource: processed.grid.source,
        upscaleFactor: processed.grid.upscaleFactor,
        originalFilename,
      });

      logger.info('upload staged as a possible duplicate', {
        uuid: pending.uuid,
        fingerprint: pending.fingerprint,
        matches: matches.length,
        nearest: matches[0]!.distance,
      });

      return renderDuplicateWarning(c, pending, matches, {
        ...values,
        // The requirement: offer the matching map's name, so keeping it and
        // adding a variant is the path of least resistance.
        name: matches[0]!.map.name,
        variant: '',
      });
    }

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
        fingerprint: processed.fingerprint,
        originalFilename,
        uploadedBy: user.id,
      });

      logger.info('map created', { uuid: map.uuid, name: map.name, variant: map.variant });
      setFlash(c, {
        kind: 'success',
        message:
          processed.grid.source === 'none'
            ? `“${map.name}” was uploaded. No grid was recorded — edit the map to add one.`
            : `“${map.name}” was uploaded.` + gridNote(processed.grid, map.imageWidth, map.imageHeight),
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
}

/**
 * Commits or discards an upload that was held back as a possible duplicate.
 *
 * The staged row is the authority for everything measured from the image — its
 * dimensions, the grid it was already resized to fit, its fingerprint. Only the
 * name, variant and tags come from this submission, because only those are the
 * admin's to change at this point. Nothing here trusts the hidden field beyond
 * naming a row that `findPendingUpload` will only return for this user and only
 * while it is still fresh.
 */
async function resolveStagedUpload(c: Context<AppEnv>, body: Record<string, unknown>): Promise<Response> {
  const logger = c.get('logger');
  const user = c.get('user')!;

  const pendingUuid = field(body, 'pendingUuid');
  const pending = isValidUuid(pendingUuid) ? findPendingUpload(pendingUuid, user.id) : null;

  if (!pending) {
    logger.warn('staged upload could not be resolved', { pendingUuid });
    throw notFound(
      'That upload is no longer waiting to be saved — it may have been discarded, or left too long. Please upload the file again.',
    );
  }

  if (field(body, 'action') === 'discard') {
    deletePendingUpload(pending.uuid);
    await deleteImage(pending.uuid);

    logger.info('staged upload discarded', { uuid: pending.uuid });
    setFlash(c, { kind: 'info', message: 'That upload was discarded. Nothing was added to the library.' });

    return c.redirect('/maps/new', 302);
  }

  const matches = findSimilarMaps(pending.fingerprint);
  let values = valuesFromPending(pending);

  try {
    // The name is offered pre-filled from the map this matched, but an admin who
    // clears it lands back on the same default the first submission would have had.
    const fallbackName = nameFromFilename(pending.originalFilename ?? '');
    values = { ...formValues(body, fallbackName), ...gridValuesFromPending(pending) };
    const { parsed } = parseMapForm(body, fallbackName);

    const map = createMap({
      uuid: pending.uuid,
      name: parsed.name,
      variant: parsed.variant,
      tags: parsed.tags,
      gridSize: pending.gridSize,
      gridWidth: pending.gridWidth,
      gridHeight: pending.gridHeight,
      gridSource: pending.gridSource,
      upscaleFactor: pending.upscaleFactor,
      imageWidth: pending.imageWidth,
      imageHeight: pending.imageHeight,
      fileSize: pending.fileSize,
      fingerprint: pending.fingerprint,
      originalFilename: pending.originalFilename,
      uploadedBy: user.id,
    });

    // Only once the row is safely in: until this point the staged row is what
    // keeps the files on disk accounted for.
    deletePendingUpload(pending.uuid);

    logger.info('map created from staged upload', { uuid: map.uuid, name: map.name, variant: map.variant });
    setFlash(c, {
      kind: 'success',
      message: `“${map.name}” was saved despite matching ${
        matches.length === 1 ? 'an existing map' : `${matches.length} existing maps`
      }.`,
    });

    return c.redirect(`/maps/${map.uuid}`, 302);
  } catch (error) {
    // Keeping the name and forgetting the variant is the likeliest way to land
    // here, so the form must come back intact rather than stranding the upload.
    return renderFormError(c, error, 'confirm', '/maps/new', values, undefined, {
      staged: stagedFrom(pending),
      matches,
    });
  }
}

const gridValuesFromPending = (pending: PendingUpload): Pick<MapFormValues, 'gridSize' | 'gridWidth' | 'gridHeight'> => ({
  gridSize: pending.gridSize?.toString() ?? '',
  gridWidth: pending.gridWidth?.toString() ?? '',
  gridHeight: pending.gridHeight?.toString() ?? '',
});

const valuesFromPending = (pending: PendingUpload): MapFormValues => ({
  name: '',
  variant: '',
  tags: '',
  ...gridValuesFromPending(pending),
});

const stagedFrom = (pending: PendingUpload): StagedUpload => ({
  uuid: pending.uuid,
  imageWidth: pending.imageWidth,
  imageHeight: pending.imageHeight,
  gridSize: pending.gridSize,
  gridWidth: pending.gridWidth,
  gridHeight: pending.gridHeight,
});

/** The interstitial: what the upload matched, over a form that can commit it. */
function renderDuplicateWarning(
  c: Context<AppEnv>,
  pending: PendingUpload,
  matches: SimilarMap[],
  values: MapFormValues,
): Response {
  return page(
    c,
    { title: 'Possible duplicate' },
    <div class="mx-auto max-w-3xl">
      <h1 class="text-2xl font-bold tracking-tight">Upload a map</h1>
      <div class="mt-6">
        <DuplicateWarning matches={matches} />
      </div>
      <div class="mt-8">
        <MapForm
          mode="confirm"
          action="/maps/new"
          csrfToken={c.get('csrfToken')}
          values={values}
          staged={stagedFrom(pending)}
        />
      </div>
    </div>,
  );
}

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
    // counts, exactly as it does on upload. Changed square counts can also call
    // for the image itself to be enlarged.
    const grid = resolveGrid(chooseGridInput(parsed, map), {
      width: map.imageWidth,
      height: map.imageHeight,
    });

    // Re-encode before touching the row, but write nothing yet: `updateMap` can
    // still reject the submission over a duplicate name, and the files on disk
    // must not have moved on by the time it does.
    const rescaled = grid.target ? await rescaleStored(map.uuid, grid.target) : null;

    const updated = updateMap(
      map.uuid,
      {
        name: parsed.name,
        variant: parsed.variant,
        tags: parsed.tags,
        gridSize: grid.gridSize,
        gridWidth: grid.gridWidth,
        gridHeight: grid.gridHeight,
        gridSource: grid.source,
        // Cumulative, so the column always reads against the original upload.
        upscaleFactor: map.upscaleFactor * grid.upscaleFactor,
      },
      rescaled ?? undefined,
    );

    if (rescaled) {
      await storeImage(map.uuid, rescaled.full, rescaled.thumb);
    }

    c.get('logger').info('map updated', {
      uuid: updated.uuid,
      name: updated.name,
      ...(rescaled ? { imageWidth: updated.imageWidth, imageHeight: updated.imageHeight } : {}),
    });
    setFlash(c, {
      kind: 'success',
      message: `“${updated.name}” was saved.` + gridNote(grid, updated.imageWidth, updated.imageHeight),
    });

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
  mode: MapFormMode,
  action: string,
  values: MapFormValues,
  map?: MapRecord,
  /** Present when the rejected submission was committing a staged upload. */
  pending?: { staged: StagedUpload; matches: SimilarMap[] },
): Response {
  const isFieldError =
    error !== null && typeof error === 'object' && 'fields' in error && (error as { fields?: unknown }).fields;

  if (!isFieldError) throw error;

  const appError = error as { userMessage: string; status: number; fields: Record<string, string> };
  c.get('logger').warn('map form rejected', { fields: Object.keys(appError.fields) });

  const heading = mode === 'edit' ? `Edit “${map?.name}”` : 'Upload a map';

  return page(
    c,
    { title: mode === 'edit' ? 'Edit map' : 'Upload a map', status: appError.status },
    <div class="mx-auto max-w-3xl">
      <h1 class="text-2xl font-bold tracking-tight">{heading}</h1>
      <div
        role="alert"
        class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200"
      >
        {appError.userMessage}
      </div>
      {/* The matches stay on screen: they are the reason the admin is being
          asked for a variant in the first place. */}
      {pending && (
        <div class="mt-6">
          <DuplicateWarning matches={pending.matches} />
        </div>
      )}
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
          staged={pending?.staged}
        />
      </div>
    </div>,
  );
}

export { badRequest };
