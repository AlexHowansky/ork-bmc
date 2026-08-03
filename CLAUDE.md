# Battle Map Curator — working notes

A server-rendered map library for tabletop games. Read `README.md` for what the
app does and `SPEC.md` for the requirements it was built against.

## Runtime

Bun, not Node. Use `bun <file>`, `bun test`, `bun install`, `bunx`.
Bun loads `.env` automatically — do not add `dotenv`.

Prefer built-ins over dependencies: `bun:sqlite` (not better-sqlite3),
`Bun.password` (not bcrypt/argon2 packages), `Bun.file` / `Bun.write` (not
`node:fs` read/write helpers). The only runtime dependencies are `hono` and
`sharp`, and it is worth keeping it that way.

## Commands

```bash
bun run dev         # rebuild CSS, then serve with watching
bun run test        # full suite — not a bare `bun test`, see below
bun run typecheck   # tsc --noEmit — run before calling anything done
bun run build       # required after adding Tailwind classes
bun run migrate
```

## Things that will bite you

- **The suite runs with `--no-env-file`, so use `bun run test`.** A bare
  `bun test` reads your `.env` and the run then depends on an untracked file —
  which is how a machine with `WEB_SEARCH_PROVIDER` set fails a test that passes
  in CI. Under the flag, config in tests is `config.ts` defaults plus whatever
  `tests/setup.ts` assigns, and a test needing a non-default setting sets it
  there. The flag does not block a variable exported in your shell; only the
  preload can.
- **Tailwind classes are compiled from source.** After adding a class in a
  `.tsx` file, run `bun run build` or it simply will not apply. `styles/app.css`
  lists the scanned paths; `public/app.js` is one of them, but classes the script
  toggles are better declared in `src/views/ui.ts` and passed to it in a data
  attribute, as the upload drop zone does.
- **Route order matters.** `adminRoutes` is mounted before `mapRoutes` in
  `server.tsx` because `/maps/new` would otherwise be swallowed by
  `/maps/:uuid`. Adding another literal `/maps/<word>` route needs the same care.
- **Middleware order matters** and is documented at the top of `server.tsx`.
  `attachSession` must run before anything that can throw, because the error
  page is rendered from that same context.
- **Do not use `c.header()` after a response is finalised.** Hono rebuilds the
  response from its body stream, which drops `Content-Length`. `securityHeaders`
  writes to `c.res.headers` directly for this reason.
- **The CSP has no `unsafe-inline`.** No inline `<script>`, and no `style`
  attributes. The single dynamic style (the grid overlay) uses a per-request
  nonce; see `gridOverlayCss` in `views/Layout.tsx`.
- **`public/app.js` duplicates three server functions on purpose.**
  `nameFromFilename` and `filenameFromUrl` (`src/models/maps.ts`) and
  `gridFromFilename` (`src/images/grid.ts`) are the authorities: the upload route
  applies them to the file — or the address — it receives. `app.js` carries an ES5
  copy of each so the name and the square counts appear as soon as a file is
  picked or an address is pasted. Change one, change the other, or the field an
  admin sees stops matching what gets saved.
- **The upload form takes a file *or* an address, never both.** `POST /maps/new`
  reads `image` and `imageUrl` and rejects a submission carrying both or neither;
  the file input is deliberately not `required`, because that attribute would
  have the browser block a submission carrying only an address. From the point
  the bytes are in hand the two are the same path — same limits, same staging,
  same duplicate check — so nothing downstream needs to know which happened.
- **A map's storage format lives on its row, not in the config.** `IMAGE_FORMAT`
  decides what a *new* upload is encoded as; `maps.format` records what each one
  actually is, and that is what names the file on disk and sets the
  `Content-Type`. Anything that opens, serves, or renames a stored file needs
  the format from the row — never `config.image.format`. `deleteImage` is the
  deliberate exception: it sweeps every extension so a format change cannot
  strand a file.
- **`GET /maps` can answer with a 302.** The last search is remembered in the
  `bmc_search` cookie, so arriving at the listing with no query of its own
  restores it — see `src/searchMemory.ts`. Clearing is `/maps?clear=1`, never a
  bare `/maps`, which would only put the search back. Anything asserting a 200
  from `/maps` has to run before a search or after a clear.
- **Adding a route makes it private by default.** Anything reachable while
  signed out must be listed in `PUBLIC_PATHS` in `auth/middleware.ts`, which
  matches `c.req.path` *exactly* — a parameterised public route is not
  expressible, and `/staged-image?t=…` puts its token in the query for precisely
  that reason. Do not turn that set into prefix matching to avoid the problem.
- **Every upload is staged, even the ordinary ones.** `createFromUpload` writes
  a `pending_uploads` row before it asks anything about the image, then commits
  and deletes it in the same request when there is nothing to report. So a clean
  upload still 302s to the new map and leaves no row behind — but any code that
  assumes a row means "duplicate" is wrong.
- **A successful upload does not always redirect.** `POST /maps/new` returns 200
  with a review form, and the map is created by a second POST carrying
  `pendingUuid`, when either the image fingerprints close to a map already in
  the library *or* a higher-resolution copy was found on the web. Tests that
  upload the same fixture twice will hit the first — `makeMapPng` paints a
  different map per call for that reason, and takes a `seed` when a test wants a
  deliberate duplicate.
- **`processUpload` writes to disk; `prepareUpload` does not.** Anything that
  has to look at the result before committing to it — adopting a copy found on
  the web reuses the staged UUID, so writing first would destroy the admin's own
  file — must use `prepareUpload` and call `storeImage` itself. `rescaleStored`
  withholds its buffers for the same reason.
- **The web search must never fail an upload.** `findHigherResolution` in
  `src/websearch/` catches everything and returns 0. It sits in the upload path,
  and a provider having a bad day is not the admin's problem. Anything added
  there keeps that property.
- **`src/websearch/fetchImage.ts` is the only place that dereferences a URL the
  app did not choose.** Candidate images and pasted addresses go through it or
  not at all. Its DNS resolver is injectable because resolution happens before
  `fetch`, so a stubbed `globalThis.fetch` tests nothing about the guard. It has
  two callers with different needs, expressed as options that both default to the
  stricter behaviour: `allowInsecure` permits `http:` and is passed *only* by the
  upload route, whose address an administrator typed, never by the search path;
  `subject` names the thing being fetched in its messages. The scheme allowlist
  and the publicly-routable check are what stop it being a proxy into the local
  network, and only the first of those is negotiable.
- **`SERPAPI_KEY` normalises to `serpapikey` in the log redaction pass**, which
  strips `-` and `_`. That is why `src/log.ts` lists `serpapikey` and not just
  `apikey`. The SerpApi request URL carries the key in a query parameter, so
  that URL never goes into a log, an error, or a `cause`.

## Conventions

- Errors thrown to the user are `AppError` from `src/errors.ts`. `userMessage`
  is rendered; the cause stays in the log. Never surface a raw exception.
- Validation failures use `validationFailed({ field: message })` so the form can
  re-render with the user's input intact.
- Log through `src/log.ts`, never `console.*`. Secrets are redacted by field
  name, but do not rely on that — avoid passing them in the first place.
- SQL goes through prepared statements. Search terms are quoted for FTS5 by
  `buildMatchExpression`; never interpolate user text into a MATCH expression.
- Storage paths are derived only from a validated UUID v4. Do not add a code
  path that builds a path from anything else.
- A staged upload's UUID travels through a hidden form field, so it is never
  treated as a capability: `findPendingUpload` scopes every lookup to the
  uploader and to the TTL. A candidate id is scoped to its staged upload the
  same way.
- The share token for `/staged-image` *is* a capability, and is handled like the
  session token it is modelled on: `randomToken` to mint, only `hashToken`'s
  output stored, looked up by hash so there is nothing to time-attack.

## Automatic grid detection

Runs on **upload only**, and only when all three grid fields are empty —
`resolveGrid` consults it last, after anything typed and anything read from the
file name. The edit path deliberately passes no plane, so clearing the fields
and saving does not re-measure. Every `config.grid.*` setting is live.

- `src/images/gridDetect.ts` is the signal processing: edge-energy projections,
  a comb filter over candidate periods, sub-pixel refinement. Pure arithmetic
  over a `RawImage`, no sharp, testable on a hand-built buffer.
- `detectGrid` in `grid.ts` turns a measurement into a grid: reconcile the axes,
  snap a near-whole square size, hand it to `solveIntegerUpscale`.
- `analysisPlane` in `process.ts` is the only part that touches sharp. It may
  hand `detectGrid` a **downscaled** plane, which is why `detectGrid` takes the
  real image size as a second argument — a period measured on the plane means
  nothing without it.

Two things to know before changing the fixtures: **`makeMapPng` paints a grid
the detector finds**, so a test that wants an ungridded upload has to use
`makePlainPng`; and `paintGridPlane` is the greyscale builder for detector
tests, with anti-aliased lines so fractional periods can be painted honestly.
