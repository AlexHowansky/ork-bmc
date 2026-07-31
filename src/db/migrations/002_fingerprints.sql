-- Perceptual fingerprints and the staging area that duplicate detection needs.
--
-- A fingerprint is the 16 hex characters `src/images/fingerprint.ts` produces
-- from an image's low-frequency content. It is NULL on every map uploaded before
-- this migration: there is no way to derive one without re-reading the stored
-- file, and a map with no fingerprint is simply never offered as a match.

ALTER TABLE maps ADD COLUMN fingerprint TEXT;

-- Near-duplicate matching is a Hamming distance, which no index can answer —
-- that scan happens in `findSimilarMaps`. This index is for the exact-match
-- lookups that identify a byte-for-byte re-upload.
CREATE INDEX idx_maps_fingerprint ON maps(fingerprint);

-- An upload whose fingerprint matched an existing map, held back so the admin
-- can be shown the matches before anything joins the library.
--
-- A row here means the image files are already written under `uuid` but no map
-- exists yet. Confirming turns it into a `maps` row that keeps the same UUID, so
-- the files never move; discarding — or the maintenance sweep, once the row has
-- aged past PENDING_UPLOAD_TTL_SECONDS — deletes both the row and the files.
--
-- The geometry columns mirror `maps` because the grid was resolved, and any
-- upscale it called for already applied to the stored pixels, before the
-- duplicate check ran. They are carried here rather than re-derived on confirm
-- so that what is committed is exactly what was processed.
CREATE TABLE pending_uploads (
  uuid              TEXT    PRIMARY KEY,
  -- Scoped to the uploader: a staged UUID is not a capability another admin can
  -- borrow by guessing it out of a form.
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint       TEXT    NOT NULL,
  grid_size         INTEGER CHECK (grid_size   IS NULL OR grid_size   > 0),
  grid_width        INTEGER CHECK (grid_width  IS NULL OR grid_width  > 0),
  grid_height       INTEGER CHECK (grid_height IS NULL OR grid_height > 0),
  image_width       INTEGER NOT NULL CHECK (image_width  > 0),
  image_height      INTEGER NOT NULL CHECK (image_height > 0),
  file_size         INTEGER NOT NULL CHECK (file_size >= 0),
  grid_source       TEXT    NOT NULL DEFAULT 'none'
                            CHECK (grid_source IN ('none', 'user', 'detected', 'estimated')),
  upscale_factor    REAL    NOT NULL DEFAULT 1.0 CHECK (upscale_factor >= 1.0),
  original_filename TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_pending_uploads_created ON pending_uploads(created_at);
CREATE INDEX idx_pending_uploads_user    ON pending_uploads(user_id);
