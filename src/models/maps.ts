/**
 * Map records, tag normalisation, and the search query builder.
 *
 * `maps` holds the canonical columns; `maps_fts` is a search index kept in step
 * by triggers. Searches read the index and join back for the full row.
 */
import { config, type ImageFormat } from '../config.ts';
import { db } from '../db/index.ts';
import { conflict, notFound, validationFailed } from '../errors.ts';
import { hammingDistance, isValidFingerprint } from '../images/fingerprint.ts';
import type { GridSource } from '../images/grid.ts';

export interface MapRecord {
  uuid: string;
  name: string;
  variant: string;
  /** The format the files on disk are actually in; see IMAGE_FORMAT. */
  format: ImageFormat;
  tags: string[];
  gridSize: number | null;
  gridWidth: number | null;
  gridHeight: number | null;
  imageWidth: number;
  imageHeight: number;
  fileSize: number;
  gridSource: GridSource;
  upscaleFactor: number;
  /** Null on maps uploaded before fingerprinting existed; those never match. */
  fingerprint: string | null;
  originalFilename: string | null;
  uploadedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface MapRow {
  uuid: string;
  name: string;
  variant: string;
  format: ImageFormat;
  tags: string;
  grid_size: number | null;
  grid_width: number | null;
  grid_height: number | null;
  image_width: number;
  image_height: number;
  file_size: number;
  grid_source: GridSource;
  upscale_factor: number;
  fingerprint: string | null;
  original_filename: string | null;
  uploaded_by: string | null;
  created_at: number;
  updated_at: number;
}

const toMap = (row: MapRow): MapRecord => ({
  uuid: row.uuid,
  name: row.name,
  variant: row.variant,
  format: row.format,
  tags: parseTags(row.tags),
  gridSize: row.grid_size,
  gridWidth: row.grid_width,
  gridHeight: row.grid_height,
  imageWidth: row.image_width,
  imageHeight: row.image_height,
  fileSize: row.file_size,
  gridSource: row.grid_source,
  upscaleFactor: row.upscale_factor,
  fingerprint: row.fingerprint,
  originalFilename: row.original_filename,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const MAX_NAME_LENGTH = 200;

/**
 * Derives a map name from the name of the file that was uploaded.
 *
 * Used as the default when the upload form arrives without one, so an admin who
 * has already named the file on disk does not have to retype it. `public/app.js`
 * carries an ES5 copy of this so the field fills in as soon as a file is picked;
 * this is the authority, and the two must agree.
 *
 * Returns `''` when nothing usable is left, which leaves the caller's "please
 * give the map a name" validation to speak.
 */
export function nameFromFilename(filename: string): string {
  // Some clients still send a full path rather than a bare filename.
  const base = filename.split(/[\\/]/).pop() ?? '';

  // A leading-dot filename is all extension, so keep it rather than derive "".
  const stem = base.replace(/\.[^.]+$/, '') || base;

  return (
    stem
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // Only the first character of each word: "map 2 (night)" becomes
      // "Map 2 (night)", and "DUNGEON" is left as the admin typed it.
      .replace(/(^|\s)(\S)/g, (_match, lead: string, first: string) => lead + first.toUpperCase())
      .slice(0, MAX_NAME_LENGTH)
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const MAX_TAGS = 40;
export const MAX_TAG_LENGTH = 32;

/**
 * Parses free-text tag input into the canonical form: lowercase letters only,
 * de-duplicated and sorted.
 *
 * The spec restricts tags to lowercase letters, so anything else is a typo
 * rather than something to preserve. Reporting rejects instead of silently
 * dropping them means "Forest, Road!" does not quietly become nothing.
 */
export function parseTagInput(raw: string): { tags: string[]; rejected: string[] } {
  const candidates = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const tags = new Set<string>();
  const rejected: string[] = [];

  for (const candidate of candidates) {
    const lowered = candidate.toLowerCase();
    if (!/^[a-z]+$/.test(lowered) || lowered.length > MAX_TAG_LENGTH) {
      rejected.push(candidate);
      continue;
    }
    tags.add(lowered);
  }

  return { tags: [...tags].sort(), rejected };
}

/**
 * Serialises tags for the `tags` column.
 *
 * The leading and trailing spaces matter: they let a `LIKE '% road %'` match a
 * whole tag without also matching "crossroads".
 */
export function serialiseTags(tags: string[]): string {
  return tags.length === 0 ? '' : ` ${tags.join(' ')} `;
}

export function parseTags(stored: string): string[] {
  return stored.trim().split(/\s+/).filter(Boolean);
}

export function assertTagsAcceptable(rejected: string[], count: number): void {
  if (rejected.length > 0) {
    throw validationFailed({
      tags:
        `Tags may only contain lowercase letters. Could not use: ${rejected.slice(0, 5).join(', ')}` +
        (rejected.length > 5 ? `, and ${rejected.length - 5} more.` : '.'),
    });
  }
  if (count > MAX_TAGS) {
    throw validationFailed({ tags: `Please use at most ${MAX_TAGS} tags.` });
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type TagMode = 'any' | 'all';
export type SortOrder = 'newest' | 'oldest' | 'name';

export interface SearchQuery {
  /** Free text matched against the map name. */
  text?: string | undefined;
  tags?: string[] | undefined;
  tagMode?: TagMode | undefined;
  sort?: SortOrder | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
}

export interface SearchResult {
  maps: MapRecord[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

/**
 * Quotes a term for an FTS5 MATCH expression.
 *
 * FTS5 has its own query syntax — `AND`, `OR`, `NOT`, `NEAR`, `*`, `^`, `:`,
 * parentheses. Wrapping a term in double quotes (doubling any it contains)
 * makes FTS5 treat it as a literal string, so user text cannot become an
 * operator. This is the FTS equivalent of parameterising a query, and it is why
 * `forest OR *` searches for those words rather than executing them.
 */
function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Builds the MATCH expression for a search, or null when nothing was asked for. */
export function buildMatchExpression(text: string | undefined, tags: string[], mode: TagMode): string | null {
  const clauses: string[] = [];

  if (tags.length > 0) {
    // Tags are already restricted to [a-z]+ by `parseTagInput`; quoting is
    // belt-and-braces in case a caller passes something else.
    const joiner = mode === 'all' ? ' AND ' : ' OR ';
    clauses.push(`tags:(${tags.map(quoteFtsTerm).join(joiner)})`);
  }

  const words = (text ?? '')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length > 0) {
    // All words must appear in the name; the last gets a prefix match so
    // "riv cros" finds "River Crossing" as the user is still typing.
    const terms = words.map((word, index) =>
      index === words.length - 1 ? `${quoteFtsTerm(word)}*` : quoteFtsTerm(word),
    );
    clauses.push(`name:(${terms.join(' AND ')})`);
  }

  if (clauses.length === 0) return null;
  return clauses.join(' AND ');
}

const SORT_SQL: Record<SortOrder, string> = {
  newest: 'm.created_at DESC',
  oldest: 'm.created_at ASC',
  name: 'm.name COLLATE NOCASE ASC, m.variant COLLATE NOCASE ASC',
};

export function searchMaps(query: SearchQuery): SearchResult {
  const perPage = Math.min(Math.max(query.perPage ?? 24, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const sort = SORT_SQL[query.sort ?? 'newest'];

  const match = buildMatchExpression(query.text, query.tags ?? [], query.tagMode ?? 'any');

  const where = match ? 'WHERE m.rowid IN (SELECT rowid FROM maps_fts WHERE maps_fts MATCH ?)' : '';
  const params = match ? [match] : [];

  const total = (
    db.query(`SELECT COUNT(*) AS n FROM maps m ${where}`).get(...params) as { n: number }
  ).n;

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);

  const rows = db
    .query(`SELECT m.* FROM maps m ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`)
    .all(...params, perPage, (safePage - 1) * perPage) as MapRow[];

  return { maps: rows.map(toMap), total, page: safePage, perPage, totalPages };
}

/** Every distinct tag in use, with how many maps carry it. */
export function listAllTags(): { tag: string; count: number }[] {
  const rows = db.query('SELECT tags FROM maps WHERE tags != ""').all() as { tags: string }[];
  const counts = new Map<string, number>();

  for (const row of rows) {
    for (const tag of parseTags(row.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function findMap(uuid: string): MapRecord | null {
  const row = db.query('SELECT * FROM maps WHERE uuid = ?').get(uuid) as MapRow | null;
  return row ? toMap(row) : null;
}

/** Other variants of the same map name, for the "see also" list on a detail page. */
export function findSiblingVariants(uuid: string, name: string): MapRecord[] {
  const rows = db
    .query('SELECT * FROM maps WHERE name = ? COLLATE NOCASE AND uuid != ? ORDER BY variant COLLATE NOCASE')
    .all(name, uuid) as MapRow[];
  return rows.map(toMap);
}

export function countMaps(): number {
  return (db.query('SELECT COUNT(*) AS n FROM maps').get() as { n: number }).n;
}

export interface SimilarMap {
  map: MapRecord;
  /** Bits of the 64-bit fingerprint that differ; 0 is an exact visual match. */
  distance: number;
}

/**
 * Finds the maps whose fingerprint is close enough to be the same picture.
 *
 * Every candidate is scored in JavaScript, because SQLite has no `popcount` and
 * a Hamming distance is not something an index can answer — there is no ordering
 * of hashes under which near-matches are adjacent. Only `uuid` and `fingerprint`
 * are read for the scan, and full rows are fetched for the handful that survive.
 *
 * That makes this linear in the size of the library, which is the right trade
 * for a personal map collection: 100 000 maps would still be a couple of
 * milliseconds of comparisons on an upload that already spent far longer in
 * sharp. If it ever stops being, the usual next step is to bucket by a few bits
 * of the hash and only score the buckets within reach of the threshold.
 */
export function findSimilarMaps(
  fingerprint: string,
  options: { maxDistance?: number; excludeUuid?: string; limit?: number } = {},
): SimilarMap[] {
  if (!isValidFingerprint(fingerprint)) {
    throw new Error('findSimilarMaps needs a fingerprint in the form perceptualHash returns');
  }

  const maxDistance = options.maxDistance ?? config.fingerprint.maxDistance;
  const limit = options.limit ?? 20;

  const candidates = db
    .query('SELECT uuid, fingerprint FROM maps WHERE fingerprint IS NOT NULL')
    .all() as { uuid: string; fingerprint: string }[];

  return candidates
    .filter((row) => row.uuid !== options.excludeUuid && isValidFingerprint(row.fingerprint))
    .map((row) => ({ uuid: row.uuid, distance: hammingDistance(fingerprint, row.fingerprint) }))
    .filter((scored) => scored.distance <= maxDistance)
    // Nearest first, so the caller can treat the head as the best match — it is
    // the name the upload form is pre-filled from.
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((scored) => ({ map: findMap(scored.uuid), distance: scored.distance }))
    .filter((similar): similar is SimilarMap => similar.map !== null);
}

export interface MapInput {
  name: string;
  variant: string;
  tags: string[];
  gridSize: number | null;
  gridWidth: number | null;
  gridHeight: number | null;
  gridSource: GridSource;
  upscaleFactor: number;
}

/** The measurements of a freshly re-encoded file, when an edit replaced one. */
export interface UpdatedImage {
  imageWidth: number;
  imageHeight: number;
  fileSize: number;
  /** Re-taken from the new pixels, so the column always describes what is on disk. */
  fingerprint: string;
}

export interface CreateMapInput extends MapInput {
  uuid: string;
  format: ImageFormat;
  imageWidth: number;
  imageHeight: number;
  fileSize: number;
  fingerprint: string | null;
  originalFilename: string | null;
  uploadedBy: string | null;
}

/** Turns the UNIQUE(name, variant) violation into a message an admin can act on. */
function asFriendlyConflict(error: unknown, name: string, variant: string): never {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('UNIQUE') && message.includes('maps.name')) {
    throw conflict(
      variant
        ? `A map called “${name}” already has a “${variant}” variant.`
        : `A map called “${name}” already exists. Give this one a variant name to tell them apart.`,
      { fields: { variant: 'This name and variant combination is already taken.' } },
    );
  }
  throw error;
}

export function createMap(input: CreateMapInput): MapRecord {
  const now = Date.now();

  try {
    db.query(
      `INSERT INTO maps (uuid, name, variant, format, tags, grid_size, grid_width, grid_height,
                         image_width, image_height, file_size, grid_source, upscale_factor,
                         fingerprint, original_filename, uploaded_by, created_at, updated_at)
       VALUES ($uuid, $name, $variant, $format, $tags, $gridSize, $gridWidth, $gridHeight,
               $imageWidth, $imageHeight, $fileSize, $gridSource, $upscaleFactor,
               $fingerprint, $originalFilename, $uploadedBy, $createdAt, $updatedAt)`,
    ).run({
      $uuid: input.uuid,
      $name: input.name,
      $variant: input.variant,
      $format: input.format,
      $tags: serialiseTags(input.tags),
      $gridSize: input.gridSize,
      $gridWidth: input.gridWidth,
      $gridHeight: input.gridHeight,
      $imageWidth: input.imageWidth,
      $imageHeight: input.imageHeight,
      $fileSize: input.fileSize,
      $gridSource: input.gridSource,
      $upscaleFactor: input.upscaleFactor,
      $fingerprint: input.fingerprint,
      $originalFilename: input.originalFilename,
      $uploadedBy: input.uploadedBy,
      $createdAt: now,
      $updatedAt: now,
    });
  } catch (error) {
    asFriendlyConflict(error, input.name, input.variant);
  }

  return findMap(input.uuid)!;
}

/**
 * Rewrites a map's metadata.
 *
 * `image` is supplied only when the edit resized the stored file — changing the
 * square counts can call for an enlargement — and the existing dimensions are
 * kept untouched otherwise.
 */
export function updateMap(uuid: string, input: MapInput, image?: UpdatedImage): MapRecord {
  const current = findMap(uuid);
  if (!current) throw notFound('That map does not exist.');

  try {
    db.query(
      `UPDATE maps
          SET name = $name, variant = $variant, tags = $tags,
              grid_size = $gridSize, grid_width = $gridWidth, grid_height = $gridHeight,
              grid_source = $gridSource, upscale_factor = $upscaleFactor,
              image_width = $imageWidth, image_height = $imageHeight, file_size = $fileSize,
              fingerprint = $fingerprint, updated_at = $updatedAt
        WHERE uuid = $uuid`,
    ).run({
      $uuid: uuid,
      $name: input.name,
      $variant: input.variant,
      $tags: serialiseTags(input.tags),
      $gridSize: input.gridSize,
      $gridWidth: input.gridWidth,
      $gridHeight: input.gridHeight,
      $gridSource: input.gridSource,
      $upscaleFactor: input.upscaleFactor,
      $imageWidth: image?.imageWidth ?? current.imageWidth,
      $imageHeight: image?.imageHeight ?? current.imageHeight,
      $fileSize: image?.fileSize ?? current.fileSize,
      $fingerprint: image?.fingerprint ?? current.fingerprint,
      $updatedAt: Date.now(),
    });
  } catch (error) {
    asFriendlyConflict(error, input.name, input.variant);
  }

  return findMap(uuid)!;
}

export function deleteMap(uuid: string): void {
  db.query('DELETE FROM maps WHERE uuid = ?').run(uuid);
}
