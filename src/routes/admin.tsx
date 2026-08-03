/**
 * Administrator routes: upload, edit, delete.
 *
 * Every route here is mounted behind `requireAdmin`, so a viewer receives a 403
 * even if they discover the URL — hiding the buttons is presentation, not
 * access control.
 */
import { Hono, type Context } from 'hono';

import { requireAdmin } from '../auth/middleware.ts';
import { config } from '../config.ts';
import { badRequest, isAppError, notFound, validationFailed } from '../errors.ts';
import { isSimilar } from '../images/fingerprint.ts';
import { prepareUpload, processUpload, rescaleStored } from '../images/process.ts';
import { gridFromFilename, resolveGrid, type GridInput, type ResolvedGrid } from '../images/grid.ts';
import { deleteImage, isValidUuid, storeImage } from '../images/storage.ts';
import {
  assertTagsAcceptable,
  createMap,
  deleteMap,
  findMap,
  filenameFromUrl,
  findSimilarMaps,
  nameFromFilename,
  parseTagInput,
  updateMap,
  MAX_NAME_LENGTH,
  MAX_TAGS,
  type MapRecord,
  type SimilarMap,
} from '../models/maps.ts';
import {
  createPendingUpload,
  deletePendingUpload,
  findPendingUpload,
  updatePendingImage,
  type PendingUpload,
} from '../models/pendingUploads.ts';
import { candidatesFor, findCandidate, type UploadCandidate } from '../models/uploadCandidates.ts';
import type { AppEnv } from '../types.ts';
import { findHigherResolution } from '../websearch/index.ts';
import { fetchRemoteImage } from '../websearch/fetchImage.ts';
import { DuplicateWarning } from '../views/DuplicateWarning.tsx';
import type { Flash } from '../views/Layout.tsx';
import { MapForm, storageDescription, type MapFormMode, type MapFormValues, type StagedUpload } from '../views/MapForm.tsx';
import { page, setFlash } from '../views/render.tsx';
import { UpgradeOffer } from '../views/UpgradeOffer.tsx';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('/maps/new', requireAdmin());
adminRoutes.use('/maps/:uuid/edit', requireAdmin());
adminRoutes.use('/maps/:uuid/delete', requireAdmin());

const MAX_VARIANT_LENGTH = 100;

/**
 * The longest address worth trying to parse. Real image URLs are nowhere near
 * this, and it keeps a paste of something that is not a URL at all out of the
 * fetch path.
 */
const MAX_URL_LENGTH = 2000;

const emptyValues = (): MapFormValues => ({
  name: '',
  variant: '',
  tags: '',
  imageUrl: '',
  gridSize: '',
  gridWidth: '',
  gridHeight: '',
});

const valuesFromMap = (map: MapRecord): MapFormValues => ({
  name: map.name,
  variant: map.variant,
  tags: map.tags.join(' '),
  imageUrl: '',
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
    imageUrl: field(body, 'imageUrl'),
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

/**
 * The tags to offer on the duplicate-confirmation form.
 *
 * Everything the matched maps carry, plus anything the admin had already typed,
 * normalised and de-duplicated by the same parser the form uses. They arrive in
 * the field rather than being applied at save time, so they are visible before
 * anything is committed and can be edited or emptied like any other value — an
 * admin who clears the field means it.
 */
function tagsFromMatches(typed: string, matches: SimilarMap[]): string {
  const { tags } = parseTagInput([typed, ...matches.map((match) => match.map.tags.join(' '))].join(' '));

  // The union of several maps' tags can in principle outrun the per-map limit,
  // and offering a value that validation would then reject helps nobody.
  return tags.slice(0, MAX_TAGS).join(' ');
}

/**
 * Says where a grid the admin did not type came from, in the success flash.
 *
 * Worth a sentence in both cases: nobody entered these numbers, and they are
 * about to stand as the map's grid, so the admin should get a chance to glance
 * at them rather than discover them later.
 */
function gridOrigin(grid: ResolvedGrid, namedGrid: { gridWidth: number; gridHeight: number } | null): string {
  if (namedGrid) {
    return ` Its ${namedGrid.gridWidth}×${namedGrid.gridHeight} grid was read from the file name.`;
  }

  const measured = ` A ${grid.gridWidth}×${grid.gridHeight} grid of ${grid.gridSize}px squares was measured on the image`;

  if (grid.source === 'detected') return `${measured}.`;
  if (grid.source === 'estimated') return `${measured}, though not from much — please check it.`;
  return '';
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
        The image is converted to {storageDescription()} and stored under a new identifier.
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
 * A first submission carries a file, or an address to fetch one from. It is
 * always staged first, and then two
 * questions are asked of it: does it look like a map already in the library, and
 * is there a better copy of it on the web. If neither turns anything up — the
 * overwhelmingly common case — the map is created straight away and this behaves
 * exactly as it always has, redirecting to the new map. If either does, the
 * admin is shown what was found and nothing joins the library until they say so.
 *
 * A second submission carries `pendingUuid` instead of a file, and commits that
 * staged upload, replaces its image with a copy found on the web, or throws it
 * away.
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
  // Set the moment the image is on disk, so the catch below knows whether there
  // is still an upload to come back to.
  let pending: PendingUpload | null = null;

  try {
    // A file or an address, never both and never neither. Only the file's *name*
    // is read here, not its bytes: it is what an unnamed map is named after, and
    // the checks below still own rejecting a file that is not usable.
    const submitted = body['image'];
    const file = submitted instanceof File && submitted.size > 0 ? submitted : null;
    const imageUrl = field(body, 'imageUrl');

    // The name to derive a map name and a grid from, whichever way the image
    // arrived. Everything downstream reads this rather than asking which it was.
    const sourceName = file ? file.name.slice(0, 255) : filenameFromUrl(imageUrl);

    const fallbackName = nameFromFilename(sourceName);
    // Before validating, so a rejected submission comes back intact.
    values = formValues(body, fallbackName);
    const { parsed } = parseMapForm(body, fallbackName);

    if (file && imageUrl !== '') {
      throw validationFailed({ imageUrl: 'Choose a file or paste an address, not both.' });
    }
    if (!file && imageUrl === '') {
      throw validationFailed({ image: 'Please choose an image file to upload, or paste the address of one.' });
    }
    if (imageUrl.length > MAX_URL_LENGTH) {
      throw validationFailed({ imageUrl: 'That address is too long to be a link to an image.' });
    }

    // Square counts written into the filename stand in for an untouched grid
    // section — "Forest Road 40x30.png" means 40 across and 30 down. Anything
    // the admin typed, including a grid size on its own, outranks them.
    const fromFilename = gridFromFilename(sourceName);
    const untouchedGrid =
      parsed.gridSize === undefined && parsed.gridWidth === undefined && parsed.gridHeight === undefined;
    const namedGrid = untouchedGrid ? fromFilename : null;

    if (namedGrid) {
      values = { ...values, gridWidth: String(namedGrid.gridWidth), gridHeight: String(namedGrid.gridHeight) };
    }

    const inputGrid = namedGrid ?? chooseGridInput(parsed);
    const bytes = file ? new Uint8Array(await file.arrayBuffer()) : await download(imageUrl);
    const processed = await processUpload(bytes, { grid: inputGrid });
    const originalFilename = sourceName || null;

    // Staged before anything is asked about it. Both questions below can take a
    // while — one of them talks to a third party — and from here on the files on
    // disk are accounted for by a row, so a request that dies partway through
    // leaves an upload the sweep will reclaim rather than two orphaned files.
    pending = createPendingUpload({
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
      format: processed.format,
      inputGrid,
    });

    const matches = findSimilarMaps(processed.fingerprint);
    const upgrades = await findHigherResolution(pending, { wanted: wantsWebSearch(body), logger });

    if (matches.length > 0 || upgrades > 0) {
      logger.info('upload held for review', {
        uuid: pending.uuid,
        fingerprint: pending.fingerprint,
        matches: matches.length,
        ...(matches[0] ? { nearest: matches[0].distance } : {}),
        upgrades,
      });

      return renderReview(
        c,
        pending,
        matches,
        matches.length > 0
          ? {
              ...values,
              // The requirement: offer the matching map's name, so keeping it and
              // adding a variant is the path of least resistance.
              name: matches[0]!.map.name,
              variant: '',
              // Same reasoning for the tags: a new variant of a map already in the
              // library wants the same tags, and retyping them by hand is how a
              // variant ends up findable under a different set than its siblings.
              tags: tagsFromMatches(values.tags, matches),
            }
          : values,
      );
    }

    const map = commitPending(c, pending, parsed);

    logger.info('map created', {
      uuid: map.uuid,
      name: map.name,
      variant: map.variant,
      ...(file ? {} : { importedFrom: imageUrl }),
      ...(namedGrid ? { gridFromFilename: `${namedGrid.gridWidth}x${namedGrid.gridHeight}` } : {}),
    });
    setFlash(c, {
      kind: 'success',
      message:
        processed.grid.source === 'none'
          ? `“${map.name}” was uploaded. No grid was recorded — edit the map to add one.`
          : `“${map.name}” was uploaded.` +
            gridOrigin(processed.grid, namedGrid) +
            gridNote(processed.grid, map.imageWidth, map.imageHeight),
    });

    return c.redirect(`/maps/${map.uuid}`, 302);
  } catch (error) {
    // Once the upload is staged, a rejected submission — almost always a name
    // and variant the library already has — can come back as the confirmation
    // form rather than an empty upload page. The file is still on disk and still
    // accounted for, so there is no reason to make the admin go and find it
    // again just to correct a variant.
    return pending
      ? renderFormError(c, error, 'confirm', '/maps/new', values, undefined, {
          staged: stagedFrom(pending),
          matches: findSimilarMaps(pending.fingerprint),
          candidates: remainingCandidates(pending),
        })
      : renderFormError(c, error, 'create', '/maps/new', values);
  }
}

/** True unless the admin unticked the search box. An unticked box sends nothing. */
const wantsWebSearch = (body: Record<string, unknown>): boolean => field(body, 'searchWeb') !== '';

/**
 * Fetches an upload the admin gave the address of rather than the bytes of.
 *
 * `fetchRemoteImage` is the app's only sanctioned way to dereference a URL it
 * did not choose, and this is its second caller. `allowInsecure` is set because
 * this address was typed by an administrator rather than handed over by a search
 * provider — see the note at the top of that module for what that does and does
 * not give up.
 *
 * Its refusals arrive as a plain `AppError`, which `renderFormError` would send
 * to the error page for want of a field to attach it to. A dead link is not an
 * emergency, so it is re-thrown as a rejection of the address field and the form
 * comes back with everything typed still in it.
 */
async function download(imageUrl: string): Promise<Uint8Array> {
  try {
    return await fetchRemoteImage(imageUrl, {
      maxBytes: config.maxUploadBytes,
      timeoutMs: config.importTimeoutMs,
      allowInsecure: true,
      subject: 'That image',
    });
  } catch (error) {
    if (!isAppError(error)) throw error;
    throw validationFailed({ imageUrl: error.userMessage });
  }
}

/**
 * Turns a staged upload into a map, keeping the row until the map exists.
 *
 * The staged row is what accounts for the files on disk, so it is deleted only
 * once `createMap` has succeeded. Everything measured from the image comes from
 * the row rather than from the submission: by this point the pixels have been
 * written, and possibly replaced by a copy found on the web, and the row is the
 * only record of what they turned out to be.
 */
function commitPending(c: Context<AppEnv>, pending: PendingUpload, parsed: ParsedForm): MapRecord {
  const map = createMap({
    uuid: pending.uuid,
    // The staged files are already on disk in this format; the row inherits it
    // rather than reading IMAGE_FORMAT again, which may since have changed.
    format: pending.format,
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
    uploadedBy: c.get('user')!.id,
  });

  deletePendingUpload(pending.uuid);

  return map;
}

/**
 * The offers still worth making about a staged upload.
 *
 * Filtered by size rather than by bookkeeping: adopting a copy makes the staged
 * image that copy, so the one just taken is no longer bigger than itself and
 * drops out on its own, along with anything else that has been overtaken.
 */
function remainingCandidates(pending: PendingUpload): UploadCandidate[] {
  const stagedPixels = pending.imageWidth * pending.imageHeight;

  return candidatesFor(pending.uuid).filter((candidate) => candidate.width * candidate.height > stagedPixels);
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

  // A submit button carries one name and one value, so the chosen copy travels
  // inside the action rather than in a field of its own.
  const adopting = /^adopt:(\d+)$/.exec(field(body, 'action'));
  if (adopting?.[1]) {
    return adoptCandidate(c, pending, Number(adopting[1]), body);
  }

  const matches = findSimilarMaps(pending.fingerprint);
  let values = valuesFromPending(pending);

  try {
    // The name is offered pre-filled from the map this matched, but an admin who
    // clears it lands back on the same default the first submission would have had.
    const fallbackName = nameFromFilename(pending.originalFilename ?? '');
    values = { ...formValues(body, fallbackName), ...gridValuesFromPending(pending) };
    const { parsed } = parseMapForm(body, fallbackName);

    const map = commitPending(c, pending, parsed);

    logger.info('map created from staged upload', { uuid: map.uuid, name: map.name, variant: map.variant });
    setFlash(c, {
      kind: 'success',
      message:
        matches.length === 0
          ? `“${map.name}” was saved.`
          : `“${map.name}” was saved despite matching ${
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
      candidates: remainingCandidates(pending),
    });
  }
}

/**
 * Swaps a staged upload's image for a higher-resolution copy found on the web.
 *
 * The staged UUID is kept, so the files are replaced where they already are and
 * nothing downstream has to learn that the image changed. That is also why the
 * new bytes are prepared but not written until they have been checked: the file
 * being overwritten is the admin's own upload, and there would be no way back
 * from writing first and finding out afterwards that the copy was a different
 * map, or too large for the storage format to hold.
 *
 * Two things are verified before anything is written, and neither is taken on
 * the provider's word. The fingerprint has to match what was staged, which is
 * what turns "an index thought these look alike" into "this is the same map".
 * And it has to be genuinely bigger once decoded, because a claimed resolution
 * is often an upscale of the very image being replaced.
 */
async function adoptCandidate(
  c: Context<AppEnv>,
  pending: PendingUpload,
  candidateId: number,
  body: Record<string, unknown>,
): Promise<Response> {
  const logger = c.get('logger');

  const candidate = findCandidate(candidateId, pending.uuid);

  if (!candidate) {
    throw notFound('That copy is no longer on offer. Please choose another, or save the map as it is.');
  }

  // Whatever happens, the admin comes back to the review page with their typing
  // intact — this is a detour in the middle of filling in a form, not a new one.
  const fallbackName = nameFromFilename(pending.originalFilename ?? '');
  const values = { ...formValues(body, fallbackName), ...gridValuesFromPending(pending) };

  try {
    const bytes = await fetchRemoteImage(candidate.imageUrl, {
      maxBytes: config.webSearch.maxDownloadBytes,
      timeoutMs: config.webSearch.timeoutMs,
    });

    const prepared = await prepareUpload(bytes, {
      uuid: pending.uuid,
      // The admin's own claim about the grid, not the reading of it taken at the
      // old resolution: "70 pixel squares" and "30 squares across" describe the
      // staged image identically and this one differently.
      grid: pending.inputGrid,
      maxBytes: config.webSearch.maxDownloadBytes,
    });

    if (!isSimilar(prepared.fingerprint, pending.fingerprint)) {
      throw badRequest('That copy turned out to be a different image, so it was not used.');
    }

    if (prepared.imageWidth * prepared.imageHeight <= pending.imageWidth * pending.imageHeight) {
      throw badRequest(
        `That copy is ${prepared.imageWidth}×${prepared.imageHeight} once decoded, which is no larger than what you uploaded.`,
      );
    }

    await storeImage(pending.uuid, prepared.full, prepared.thumb, prepared.format);
    updatePendingImage(pending.uuid, {
      imageWidth: prepared.imageWidth,
      imageHeight: prepared.imageHeight,
      fileSize: prepared.fileSize,
      fingerprint: prepared.fingerprint,
      format: prepared.format,
      gridSize: prepared.grid.gridSize,
      gridWidth: prepared.grid.gridWidth,
      gridHeight: prepared.grid.gridHeight,
      gridSource: prepared.grid.source,
      upscaleFactor: prepared.grid.upscaleFactor,
    });

    logger.info('staged upload replaced with a copy found on the web', {
      uuid: pending.uuid,
      source: candidate.source,
      was: `${pending.imageWidth}x${pending.imageHeight}`,
      now: `${prepared.imageWidth}x${prepared.imageHeight}`,
    });

    const updated = findPendingUpload(pending.uuid, c.get('user')!.id)!;

    return renderReview(c, updated, findSimilarMaps(updated.fingerprint), values, {
      kind: 'success',
      message: `The image was replaced with a ${prepared.imageWidth}×${prepared.imageHeight} copy${
        candidate.source ? ` from ${candidate.source}` : ''
      }. Save the map to keep it.`,
    });
  } catch (error) {
    // A copy that will not download is the ordinary case, not an emergency:
    // hotlink protection, dead CDN links and geoblocking are all routine. The
    // staged upload is untouched, so the admin can pick another or save as is.
    if (!isAppError(error)) throw error;

    logger.info('candidate could not be adopted', { uuid: pending.uuid, reason: error.userMessage });

    return renderReview(c, pending, findSimilarMaps(pending.fingerprint), values, {
      kind: 'error',
      message: error.userMessage,
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
  imageUrl: '',
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

/**
 * The interstitial: what was found out about the upload, over a form that can
 * commit it.
 *
 * Reached for either of two reasons, and sometimes both at once — the image
 * resembles a map already in the library, or a larger copy of it exists on the
 * web. Each panel appears only when it has something to say, because a heading
 * about zero matches is worse than no heading.
 */
function renderReview(
  c: Context<AppEnv>,
  pending: PendingUpload,
  matches: SimilarMap[],
  values: MapFormValues,
  flash?: Flash,
): Response {
  const candidates = remainingCandidates(pending);

  return page(
    c,
    {
      title: matches.length > 0 ? 'Possible duplicate' : 'A better copy is available',
      ...(flash ? { flash } : {}),
    },
    <div class="mx-auto max-w-3xl">
      <h1 class="text-2xl font-bold tracking-tight">Upload a map</h1>
      {matches.length > 0 && (
        <div class="mt-6">
          <DuplicateWarning matches={matches} />
        </div>
      )}
      {candidates.length > 0 && (
        <div class="mt-6">
          <UpgradeOffer candidates={candidates} staged={stagedFrom(pending)} />
        </div>
      )}
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
    const rescaled = grid.target ? await rescaleStored(map.uuid, grid.target, map.format) : null;

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
      await storeImage(map.uuid, rescaled.full, rescaled.thumb, map.format);
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
  pending?: { staged: StagedUpload; matches: SimilarMap[]; candidates: UploadCandidate[] },
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
      {/* Whatever was found stays on screen: the matches are the reason the
          admin is being asked for a variant in the first place, and a better
          copy is still on offer after a name has been rejected. */}
      {pending && pending.matches.length > 0 && (
        <div class="mt-6">
          <DuplicateWarning matches={pending.matches} />
        </div>
      )}
      {pending && pending.candidates.length > 0 && (
        <div class="mt-6">
          <UpgradeOffer candidates={pending.candidates} staged={pending.staged} />
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
