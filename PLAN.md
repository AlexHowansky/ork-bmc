# Battle Map Curator — Implementation Plan

## Context

`SPEC.md` describes a new, from-scratch web app for managing tabletop RPG battle maps: image
files plus grid metadata, behind email/password auth, with viewer/admin roles. The project
directory currently contains nothing but `SPEC.md` — this is greenfield, so there is no existing
code to reuse and every file below is new.

The problem it solves: a small group needs a private, searchable library of battle map images
where full-resolution files are never publicly reachable, grid geometry (pixels per square,
squares wide/tall) is recorded so maps can be dropped into a VTT at the right scale, and that
geometry is eventually auto-detected from the image when the uploader doesn't know it.

Environment verified: Bun 1.3.14, Node 24, sqlite3, libwebp present.

### Decisions confirmed with the user

| Decision | Choice |
|---|---|
| Stack | Hono on Bun + `hono/jsx` server-side rendering (multi-page app, no client framework) |
| `variant` | Alternate version of the same map (`Tavern` → `day`/`night`/`burned`); siblings link on the detail page; **unique index on (name, variant)** |
| Tag search | Canonical indexed `tags` column (per spec) **plus** an FTS5 external-content index over name+tags for AND/OR |
| Fractional grid upscaling | Capped: smallest factor that makes grid size integral, within `GRID_MAX_UPSCALE` and a max-pixel ceiling; if nothing fits, round and flag the map `grid_source='estimated'` |

### Scope for this pass

**Automatic grid detection is deferred to a later session.** Everything else in `SPEC.md` is
built now. `src/images/grid.ts` ships as a stub implementing the final interface (see
[Grid detection](#grid-detection-srcimagesgridts--deferred)) and returning "not detected", so the
upload path, schema columns, and UI states are all wired and exercised — dropping in the real
detector later is a single-file change with no callers to touch.

### Assumptions (stated, not asked)

- **TypeScript**, since the spec allows anything transpiling to JS and Bun runs `.ts`/`.tsx` natively.
- **Thumbnails are lossy** (`quality: 90`, configurable). The spec's "never reduced in quality"
  rule is applied to the stored map itself, which is written as **lossless WEBP**; a thumbnail is
  a derived preview, and lossless thumbs would be needlessly large.
- **Cookie `Secure` is configurable** (`COOKIE_SECURE`), defaulting to on, so the app can run over
  plain HTTP on a LAN during development without silently breaking login.
- The CLI takes the password on argv as specified, and *additionally* accepts `--password-stdin`
  because argv passwords leak into `ps` and shell history. One extra flag, opt-in.

---

## Stack

- **Runtime**: Bun 1.3.x, TypeScript
- **Web**: `hono` + `hono/jsx` (SSR), `hono/csrf`, `hono/cookie`, `hono/logger`
- **DB**: `bun:sqlite` (built in), WAL mode, FTS5
- **Images**: `sharp` (N-API libvips)
- **CSS**: Tailwind v4 via `bunx @tailwindcss/cli`, class-strategy dark mode

> **Risk to retire first:** `sharp` is a native N-API module. Bun supports N-API and sharp is
> reported working, but this is unverified in *this* environment. Step 1 of Phase 1 is
> `bun add sharp` plus a smoke test (decode a generated PNG → lossless WEBP → read raw buffer).
> If it fails, fall back to `@jsquash/webp` + `@jsquash/resize` (WASM, pure JS, no native deps).
> Everything downstream depends on this, so it gets verified before any other code is written.

---

## Layout

```
src/
  config.ts              env parsing + fail-fast validation
  log.ts                 structured JSON logger (level, request id, redaction)
  errors.ts              AppError{ userMessage, status, cause }
  server.ts              app assembly, middleware order, onError
  db/
    index.ts             connection, PRAGMA wal/foreign_keys, prepared stmt cache
    migrate.ts           versioned via PRAGMA user_version
    migrations/001_init.sql
  models/
    users.ts  sessions.ts  maps.ts       (maps.ts holds the search query builder)
  auth/
    password.ts          Bun.password argon2id
    session.ts           create / verify / rotate / destroy, idle + absolute expiry
    middleware.ts        requireAuth, requireAdmin
  security/
    csrf.ts              per-session synchronizer token (layered under hono/csrf)
    headers.ts           CSP, HSTS, X-Frame-Options, Referrer-Policy, nosniff
    ratelimit.ts         SQLite token bucket for login
  images/
    storage.ts           uuid → sharded path, write / stream / delete
    process.ts           validate → decode → lossless WEBP → thumbnail
    grid.ts              STUB this pass — see "Grid detection" below
  routes/
    auth.tsx  maps.tsx  admin.tsx  files.ts
  views/                 Layout, MapCard, MapGrid, Pagination, SearchBar,
                         MapForm, ErrorPage, ThemeToggle
cli/user.ts              create | delete | list | change-role | change-password
styles/app.css
public/                  built CSS + favicon — the ONLY statically served directory
tests/
```

`IMAGE_DIR` lives **outside** `public/` and is never mounted as static.

---

## Database schema (`001_init.sql`)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                      -- uuid v4
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','admin')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                      -- sha256(cookie token); raw token never stored
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  user_agent TEXT, ip TEXT
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE maps (
  uuid TEXT PRIMARY KEY,                    -- uuid v4; the only external identifier
  name TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',            -- normalized: lowercase, deduped, sorted, space-delimited
  grid_size INTEGER, grid_width INTEGER, grid_height INTEGER,
  image_width INTEGER NOT NULL, image_height INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  grid_source TEXT NOT NULL DEFAULT 'none', -- user | detected | estimated | none
  upscale_factor REAL NOT NULL DEFAULT 1.0,
  original_filename TEXT,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_maps_name ON maps(name COLLATE NOCASE);
CREATE INDEX idx_maps_tags ON maps(tags);
CREATE UNIQUE INDEX idx_maps_name_variant ON maps(name COLLATE NOCASE, variant COLLATE NOCASE);
CREATE INDEX idx_maps_created ON maps(created_at DESC);

CREATE VIRTUAL TABLE maps_fts USING fts5(
  name, tags, content='maps', content_rowid='rowid', tokenize='unicode61'
);
-- + AFTER INSERT / DELETE / UPDATE triggers keeping maps_fts in sync
```

No autoincrement key is exposed anywhere; `rowid` exists only as FTS5's internal join key.

**Search builder** (`models/maps.ts`): tags sanitized to `[a-z]+` (spec: lowercase letters only),
name terms wrapped in double quotes with internal quotes doubled — so no user input can inject
FTS5 operators. Query shape:

```
maps_fts MATCH 'tags:(forest AND road)'    -- mode=all
maps_fts MATCH 'tags:(forest OR road)'     -- mode=any
maps_fts MATCH 'name:"river cross"*'       -- name search
```

FTS5's `unicode61` tokenizer folds case, satisfying the case-insensitive requirement; `COLLATE
NOCASE` covers the non-FTS lookups.

---

## Image pipeline (`images/process.ts`, `images/storage.ts`)

1. **Validate**: size ≤ `MAX_UPLOAD_BYTES`; type confirmed by **magic bytes**, not the
   client-supplied `Content-Type`; `sharp({ limitInputPixels })` guards decompression bombs.
2. **Normalize**: `sharp(buf).rotate()` applies EXIF orientation, then re-encode drops all
   metadata and any embedded payload.
3. **Store**: `sharp(...).webp({ lossless: true, effort: 4 })` → `${IMAGE_DIR}/${uuid.slice(0,2)}/${uuid}.webp`.
   Two hex chars ⇒ 256 shard directories.
4. **Thumbnail**: longest edge → `THUMB_SIZE` (400), `kernel: 'lanczos3'`,
   `webp({ quality: THUMB_QUALITY })` → `${uuid}_thumb.webp` in the same shard.
5. **Serve**: only via `routes/files.ts` behind `requireAuth`, streaming `Bun.file(path)`.
   The path is built from a UUID-regex-validated segment — no user-controlled path component, so
   traversal is structurally impossible. Download route adds `Content-Disposition: attachment`.
6. **Delete**: DB row and both files removed in a transaction-then-unlink order; orphaned files
   logged rather than left silent.

---

## Grid detection (`images/grid.ts`) — DEFERRED

Not implemented this pass. What *is* built now is the seam it will drop into:

```ts
export type GridResult =
  | { source: 'detected' | 'estimated'; gridSize: number;
      gridWidth: number; gridHeight: number; upscaleFactor: number }
  | { source: 'none' };

export function detectGrid(
  raw: { data: Buffer; width: number; height: number },
): GridResult;
```

- The stub returns `{ source: 'none' }`. The upload path already calls it, already handles every
  branch of the union, and already persists `grid_source` / `upscale_factor`.
- The UI already renders the `none` and `estimated` states — a "grid not detected, please enter
  manually" hint on the upload result and an editable-with-warning badge on the detail page.
- The `GRID_*` config keys are parsed and validated now, so the detector needs no config work.
- The re-encode step in `process.ts` is written to accept an optional upscale factor, so the
  capped-upscale behavior has somewhere to land without restructuring.

**What *is* implemented now**: manual entry of `grid size` / `grid width` / `grid height`, plus
the purely arithmetic fills — size given but not width/height ⇒ `width = round(image_width /
size)`; width/height given but not size ⇒ `size = image_width / grid_width`. These are
arithmetic, not detection, and are covered by tests.

---

## Security (OWASP Top Ten mapping)

- **A01 Access control** — every route behind `requireAuth`; all mutations behind `requireAdmin`;
  image routes authenticated; deny-by-default so a new route is unreachable until opted in.
- **A02 Crypto** — `Bun.password.hash(pw, { algorithm: 'argon2id' })`; session token = 32 random
  bytes base64url, stored SHA-256 only; cookies `HttpOnly`, `SameSite=Lax`, `Secure`
  (configurable), `__Host-` prefix when secure.
- **A03 Injection** — `bun:sqlite` prepared statements throughout; FTS terms sanitized and quoted;
  `hono/jsx` auto-escapes all interpolated output.
- **A04 Insecure design** — no self-registration; login rate-limited per-IP and per-email;
  identical generic error for unknown email vs bad password.
- **A05 Misconfiguration** — strict CSP with no inline script (theme boot script gets a hash),
  `X-Frame-Options: DENY`, `Referrer-Policy`, `nosniff`, HSTS when TLS; config validated at boot,
  process refuses to start on a bad value.
- **A06 Components** — two runtime deps (`hono`, `sharp`); `bun pm audit` documented in README.
- **A07 Auth failures** — session id rotated on login, idle + absolute expiry, server-side logout
  invalidation, CLI password/role change invalidates that user's sessions, periodic sweep of
  expired rows.
- **A08 Integrity** — magic-byte type check; full re-encode through sharp strips embedded content.
- **A09 Logging** — structured JSON with request id; auth events, admin mutations, upload/delete,
  and grid outcomes logged. Passwords, hashes, and tokens never logged.
- **A10 SSRF** — no outbound requests from user input anywhere in the app.

**CSRF** — two layers, since the spec calls it out explicitly: `hono/csrf` (Origin +
`Sec-Fetch-Site` validation) plus a per-session synchronizer token embedded as a hidden `_csrf`
field in every form and compared in constant time on every POST.

---

## UI

- **Light/dark** via Tailwind v4 `@custom-variant dark` class strategy. Theme preference stored in
  a cookie so the server emits the correct `class` on `<html>` during SSR — no flash — with a
  tiny CSP-hashed boot script reconciling `localStorage` and the `prefers-color-scheme` default.
  Toggle in the header.
- `/maps?q=&tags=&mode=any|all&page=&per=&sort=newest|name` — responsive thumbnail grid,
  `loading="lazy"`, fixed aspect-ratio boxes to prevent layout shift, pagination preserving query.
- Search bar: free-text name box, tag input, and an Any/All radio for tag logic.
- **Detail page**: full-res image, complete metadata table, sibling variants of the same name,
  a CSS grid-overlay toggle (repeating gradient at `grid_size`) to eyeball grid accuracy,
  download button, and admin edit/delete actions.
- Friendly error pages (403/404/413/500) showing only the user-safe message plus a request id
  that correlates to the server log. Form errors re-render with values preserved and per-field
  messages.

---

## CLI (`cli/user.ts`)

Non-interactive, all arguments on the command line:

```
bun run cli/user.ts create          --email a@b.c --password 'secret' --role admin|viewer
bun run cli/user.ts delete          --email a@b.c
bun run cli/user.ts list            [--json]
bun run cli/user.ts change-role     --email a@b.c --role admin|viewer
bun run cli/user.ts change-password --email a@b.c --password 'secret'
```

Validates email shape and minimum password length, prints friendly errors, exits non-zero on
failure. `--password-stdin` accepted as an alternative to argv (see Assumptions).
Plus `bun run db:migrate`.

---

## Configuration (`.env`, validated in `config.ts`)

`PORT` `HOST` `DATABASE_PATH` `IMAGE_DIR` `MAX_UPLOAD_BYTES`(25MB) `MAX_IMAGE_PIXELS`(100M)
`THUMB_SIZE`(400) `THUMB_QUALITY`(90) `PAGE_SIZE`(24) `GRID_MAX_UPSCALE`(2.0)
`GRID_MIN_CONFIDENCE` `GRID_MIN_PX` `GRID_MAX_PX` `GRID_ANALYSIS_MAX_DIM`
`SESSION_TTL_SECONDS` `SESSION_IDLE_SECONDS` `COOKIE_SECURE` `TRUST_PROXY` `LOG_LEVEL`

---

## Build order

1. **Foundation** — `bun add sharp` + smoke test *(retire the native-module risk first)*, then
   scaffold, `config.ts`, `log.ts`, `errors.ts`, db connection + migrations.
2. **Auth** — password hashing, sessions, middleware, CSRF, security headers, login page, rate
   limiting, and the CLI tool (needed to create the first admin).
3. **Images** — storage sharding, upload validation, WEBP conversion, thumbnails, admin
   upload/edit/delete routes.
4. **Grid seam** — `grid.ts` stub + the `GridResult` union, upload wiring, arithmetic fills,
   `none`/`estimated` UI states. *(Real detector: later session.)*
5. **Browse** — listing, pagination, search (FTS5 + AND/OR), detail page, variant siblings,
   download.
6. **Polish** — Tailwind theming, light/dark, error pages, empty states, accessibility pass.
7. **Tests + README** — full suite, setup and deployment docs.

---

## Verification

**Automated** (`bun test`):
- Grid arithmetic fills (size ⇄ width/height) and correct persistence of `grid_source='none'`
  from the stub. *Detector tests come with the detector.*
- Tag normalization and FTS query builder, including attempted operator injection
  (`forest OR *`, `"`, `NEAR/2`).
- Auth: hash/verify round-trip, session create/rotate/expire, idle timeout.
- Access-control matrix: anon / viewer / admin × every route, asserting the exact status codes.
- CSRF: POST without token, with a stale token, and cross-origin — all rejected.
- Upload pipeline: generated PNG → assert output is lossless WEBP, lands in the right shard
  directory, and produces correct `image_width`/`image_height`/`file_size` rows.
- CLI: each of the five commands driven via subprocess, asserting exit codes and DB state.

**Manual end-to-end**:
1. `bun run db:migrate && bun run cli/user.ts create --email admin@test.local --password '…' --role admin`
2. `bun run dev`, log in, confirm the session cookie is `HttpOnly`/`SameSite=Lax`.
3. Upload a real gridded battle map with grid fields blank → confirm it saves cleanly with
   `grid_source='none'` and shows the "enter manually" hint; then edit it, enter a grid size, and
   confirm the CSS grid overlay on the detail page lines up with the map's painted grid.
4. Upload a PNG and a JPG → both stored as `.webp`, both in the correct 2-char shard directory.
5. Search by name, by single tag, by two tags in All mode then Any mode → verify result counts.
6. Log out, then request `/i/<uuid>/full` directly → 302 to login, never the image bytes.
7. Confirm `IMAGE_DIR` files are unreachable by any URL path.
8. Create a viewer account → confirm no upload/edit/delete UI is rendered *and* that direct POSTs
   to those routes return 403.
9. Toggle light/dark, reload → theme persists with no flash of the wrong theme.
10. Upload a file over `MAX_UPLOAD_BYTES` and a `.txt` renamed to `.png` → friendly errors, both
    rejected, both logged.
