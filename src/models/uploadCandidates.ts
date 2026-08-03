/**
 * Higher-resolution copies of a staged upload, found on the web.
 *
 * A row is an offer, not a decision: it records where a larger copy of the image
 * appears to live, how big it claims to be, and a thumbnail of it, so the admin
 * can look at both before choosing. Nothing here is trusted — `image_url` is
 * only ever fetched through the SSRF guard in `src/websearch`, and whether the
 * copy really is the same map is settled by comparing fingerprints after it has
 * been downloaded, never by the provider's say-so.
 *
 * Rows belong to a `pending_uploads` row and cascade with it, so discarding an
 * upload or letting it age out takes its candidates with it. That is the whole
 * cleanup story, which is why the thumbnail is bytes in a column rather than a
 * file on disk: `deleteImage` sweeps a fixed pair of filenames per format and
 * would walk straight past a candidate file.
 */
import { type ImageFormat } from '../config.ts';
import { db } from '../db/index.ts';

export interface UploadCandidate {
  id: number;
  pendingUuid: string;
  position: number;
  /** Where the full-resolution copy is. Fetched only through the SSRF guard. */
  imageUrl: string;
  /** The page it was found on, shown to the admin as a link. */
  pageUrl: string | null;
  source: string | null;
  title: string | null;
  width: number;
  height: number;
  /** How many exact matches the provider reported. Used for ranking only. */
  exact: number;
  thumb: Uint8Array<ArrayBuffer> | null;
  thumbFormat: ImageFormat | null;
}

interface UploadCandidateRow {
  id: number;
  pending_uuid: string;
  position: number;
  image_url: string;
  page_url: string | null;
  source: string | null;
  title: string | null;
  width: number;
  height: number;
  exact: number;
  thumb: Uint8Array<ArrayBuffer> | null;
  thumb_format: ImageFormat | null;
}

const toCandidate = (row: UploadCandidateRow): UploadCandidate => ({
  id: row.id,
  pendingUuid: row.pending_uuid,
  position: row.position,
  imageUrl: row.image_url,
  pageUrl: row.page_url,
  source: row.source,
  title: row.title,
  width: row.width,
  height: row.height,
  exact: row.exact,
  thumb: row.thumb,
  thumbFormat: row.thumb_format,
});

export type UploadCandidateInput = Omit<UploadCandidate, 'id' | 'pendingUuid' | 'position'>;

/**
 * Replaces the offers for a staged upload with a fresh set.
 *
 * Replace rather than append: a search runs again after a candidate is adopted,
 * against a different image, and the previous answers describe a question that
 * is no longer being asked. Position is assigned here from the order given, so
 * ranking stays the searcher's business and this stays storage.
 */
export function replaceCandidates(pendingUuid: string, candidates: UploadCandidateInput[]): void {
  const insert = db.query(
    `INSERT INTO upload_candidates (pending_uuid, position, image_url, page_url, source, title,
                                    width, height, exact, thumb, thumb_format, created_at)
     VALUES ($pendingUuid, $position, $imageUrl, $pageUrl, $source, $title,
             $width, $height, $exact, $thumb, $thumbFormat, $createdAt)`,
  );

  db.transaction(() => {
    db.query('DELETE FROM upload_candidates WHERE pending_uuid = ?').run(pendingUuid);

    candidates.forEach((candidate, index) => {
      insert.run({
        $pendingUuid: pendingUuid,
        $position: index,
        $imageUrl: candidate.imageUrl,
        $pageUrl: candidate.pageUrl,
        $source: candidate.source,
        $title: candidate.title,
        $width: candidate.width,
        $height: candidate.height,
        $exact: candidate.exact,
        $thumb: candidate.thumb,
        $thumbFormat: candidate.thumbFormat,
        $createdAt: Date.now(),
      });
    });
  })();
}

export function candidatesFor(pendingUuid: string): UploadCandidate[] {
  const rows = db
    .query('SELECT * FROM upload_candidates WHERE pending_uuid = ? ORDER BY position')
    .all(pendingUuid) as UploadCandidateRow[];

  return rows.map(toCandidate);
}

/**
 * Looks up one offer, scoped to the upload it belongs to.
 *
 * The id arrives from a form field, so it is never enough on its own: the caller
 * has already proved the staged upload is theirs, and this will not step outside
 * it. An id from someone else's review page finds nothing.
 */
export function findCandidate(id: number, pendingUuid: string): UploadCandidate | null {
  const row = db
    .query('SELECT * FROM upload_candidates WHERE id = ? AND pending_uuid = ?')
    .get(id, pendingUuid) as UploadCandidateRow | null;

  return row ? toCandidate(row) : null;
}
