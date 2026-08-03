-- Offering a higher-resolution copy of an upload found on the web.
--
-- Two additions to the staging area and one new table. Nothing here applies to
-- maps already in the library: the search happens once, while an upload is still
-- staged, and everything it produces dies with the staged row.

-- The staged image has to be readable by the search provider, which has no
-- session and never will. The token is the bearer credential for exactly one
-- unsaved image; only its SHA-256 is stored, so a database backup yields nothing
-- usable, exactly as `sessions` does. It is minted immediately before a search,
-- cleared as soon as one returns, and expired by the maintenance sweep if the
-- process dies in between.
ALTER TABLE pending_uploads ADD COLUMN share_token TEXT;
ALTER TABLE pending_uploads ADD COLUMN share_token_expires_at INTEGER;

CREATE UNIQUE INDEX idx_pending_uploads_share
  ON pending_uploads(share_token) WHERE share_token IS NOT NULL;

-- What the admin actually typed, as opposed to what `resolveGrid` derived from
-- it. The two are not interchangeable: "70 pixel squares" and "30 squares
-- across" describe the same 2100px image but different 4200px ones, and the
-- resolved columns above cannot tell you which was meant. Adopting a
-- higher-resolution copy re-resolves the grid against new dimensions, so it
-- needs the original claim rather than a reading of it taken at the old size.
ALTER TABLE pending_uploads ADD COLUMN input_grid_size   INTEGER;
ALTER TABLE pending_uploads ADD COLUMN input_grid_width  INTEGER;
ALTER TABLE pending_uploads ADD COLUMN input_grid_height INTEGER;

-- A larger copy of the staged image found on the web, offered to the admin.
--
-- The thumbnail is held here as bytes rather than as a file beside the staged
-- image, for two reasons. The content security policy forbids loading an image
-- from another origin, so a remote thumbnail has to be served by this app
-- whatever happens; and `deleteImage` sweeps a fixed pair of filenames per
-- format, so a candidate file on disk would survive both the discard path and
-- the TTL sweep. A row cannot outlive what it belongs to: the cascade below is
-- the whole cleanup story, and `PRAGMA foreign_keys = ON` is set at startup.
CREATE TABLE upload_candidates (
  id           INTEGER PRIMARY KEY,
  pending_uuid TEXT    NOT NULL REFERENCES pending_uploads(uuid) ON DELETE CASCADE,
  -- Rank as offered: exactness first, then size. Ties are broken by insertion.
  position     INTEGER NOT NULL,
  -- Where the full-resolution copy lives, and the page it was found on. The
  -- former is fetched only through the SSRF guard in `src/websearch`, never
  -- directly; the latter is only ever rendered as a link for the admin.
  image_url    TEXT    NOT NULL,
  page_url     TEXT,
  source       TEXT,
  title        TEXT,
  width        INTEGER NOT NULL CHECK (width  > 0),
  height       INTEGER NOT NULL CHECK (height > 0),
  -- How many exact matches the provider reported for this result. A signal of
  -- how widely circulated the image is, used for ranking only — whether it is
  -- really the same map is settled by comparing fingerprints after download.
  exact        INTEGER NOT NULL DEFAULT 0 CHECK (exact >= 0),
  thumb        BLOB,
  thumb_format TEXT    CHECK (thumb_format IS NULL OR thumb_format IN ('webp', 'png', 'jpeg')),
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_upload_candidates_pending ON upload_candidates(pending_uuid, position);
