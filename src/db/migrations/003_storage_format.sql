-- The format each map is stored in.
--
-- The storage format used to be a constant — lossless WEBP for every map — and
-- the filename on disk simply ended in `.webp`. IMAGE_FORMAT now decides it per
-- upload, so the format has to be recorded rather than assumed: it is what names
-- the file on disk, and what the download and preview routes send as the
-- Content-Type. Without this column, changing IMAGE_FORMAT would strand every
-- map uploaded before the change.
--
-- 'webp' is the right default for existing rows because that is what they are,
-- and it is the default for new ones too, so nothing about an untouched install
-- changes.

ALTER TABLE maps ADD COLUMN format TEXT NOT NULL DEFAULT 'webp';

-- A staged upload has already been written to disk, so it carries the format it
-- was written in and hands it to the map row when the admin confirms. A later
-- change to IMAGE_FORMAT must not orphan a file that is mid-confirmation.
ALTER TABLE pending_uploads ADD COLUMN format TEXT NOT NULL DEFAULT 'webp';
