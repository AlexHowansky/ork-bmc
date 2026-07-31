-- Battle Mapper initial schema.
--
-- Note on identifiers: maps are addressed externally by their UUID v4 only.
-- SQLite's implicit `rowid` exists solely as the join key FTS5 requires; it is
-- never exposed in a URL, form, or API response.

CREATE TABLE users (
  id            TEXT    PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('viewer', 'admin')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- `id` holds sha256(cookie token). The raw token lives only in the user's
-- cookie, so a leaked database snapshot cannot be replayed as a live session.
CREATE TABLE sessions (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);

CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE maps (
  uuid              TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  variant           TEXT    NOT NULL DEFAULT '',
  -- Normalised on write: lowercase, de-duplicated, sorted, space-delimited,
  -- and padded with a leading/trailing space so `LIKE '% tag %'` cannot match
  -- a partial tag.
  tags              TEXT    NOT NULL DEFAULT '',
  grid_size         INTEGER CHECK (grid_size   IS NULL OR grid_size   > 0),
  grid_width        INTEGER CHECK (grid_width  IS NULL OR grid_width  > 0),
  grid_height       INTEGER CHECK (grid_height IS NULL OR grid_height > 0),
  image_width       INTEGER NOT NULL CHECK (image_width  > 0),
  image_height      INTEGER NOT NULL CHECK (image_height > 0),
  file_size         INTEGER NOT NULL CHECK (file_size >= 0),
  -- How the grid values were arrived at. 'detected' and 'estimated' are
  -- reserved for the automatic detector; nothing writes them yet.
  grid_source       TEXT    NOT NULL DEFAULT 'none'
                            CHECK (grid_source IN ('none', 'user', 'detected', 'estimated')),
  upscale_factor    REAL    NOT NULL DEFAULT 1.0 CHECK (upscale_factor >= 1.0),
  original_filename TEXT,
  uploaded_by       TEXT    REFERENCES users(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX        idx_maps_name    ON maps(name COLLATE NOCASE);
CREATE INDEX        idx_maps_tags    ON maps(tags);
CREATE INDEX        idx_maps_created ON maps(created_at DESC);
-- A variant is an alternate version of a named map, so the pair identifies it.
CREATE UNIQUE INDEX idx_maps_name_variant
  ON maps(name COLLATE NOCASE, variant COLLATE NOCASE);

-- Search accelerator over the canonical columns above. `unicode61` folds case,
-- which is what makes every search case-insensitive.
CREATE VIRTUAL TABLE maps_fts USING fts5(
  name,
  tags,
  content = 'maps',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER maps_fts_ai AFTER INSERT ON maps BEGIN
  INSERT INTO maps_fts(rowid, name, tags) VALUES (new.rowid, new.name, new.tags);
END;

CREATE TRIGGER maps_fts_ad AFTER DELETE ON maps BEGIN
  INSERT INTO maps_fts(maps_fts, rowid, name, tags) VALUES ('delete', old.rowid, old.name, old.tags);
END;

CREATE TRIGGER maps_fts_au AFTER UPDATE ON maps BEGIN
  INSERT INTO maps_fts(maps_fts, rowid, name, tags) VALUES ('delete', old.rowid, old.name, old.tags);
  INSERT INTO maps_fts(rowid, name, tags) VALUES (new.rowid, new.name, new.tags);
END;

-- Token bucket backing the login rate limiter. Keyed 'ip:<addr>' or
-- 'email:<address>' so neither a single client nor a single account can be
-- hammered, even from a botnet.
CREATE TABLE login_attempts (
  key        TEXT    PRIMARY KEY,
  tokens     REAL    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_login_attempts_updated ON login_attempts(updated_at);
