# Battle Mapper

A private, searchable library of battle maps for tabletop role-playing games.
Upload map images, record the grid geometry so they drop into a virtual tabletop
at the right scale, and find them again by name or tag.

Every page requires a sign-in, and full-resolution maps are served only through
authenticated routes — the image directory is never exposed as static files.

## Requirements

- [Bun](https://bun.com) 1.2.3 or newer (developed against 1.3.14)
- A platform `sharp` supports (Linux, macOS, or Windows on x64/arm64)

## Setup

```bash
bun install
cp .env.example .env        # optional; every setting has a default
bun run css:build           # build the stylesheet
bun run db:migrate          # create the database
```

Create the first administrator — there is no self-registration, by design:

```bash
bun run cli/user.ts create --email you@example.com --password 'a long passphrase' --role admin
```

Then start the server:

```bash
bun run dev     # rebuilds CSS, then runs with file watching
bun run start   # production
```

Visit <http://127.0.0.1:3000>.

> **Running over plain HTTP?** Session cookies are marked `Secure` by default and
> a browser will refuse to send them back over HTTP, so sign-in will appear to
> silently fail. For a LAN or development box, set `COOKIE_SECURE=false`. In
> production, terminate TLS at a reverse proxy and leave it enabled.

## Accounts

Accounts are managed entirely from the command line. All arguments are supplied
on the command line; nothing is interactive.

```bash
bun run cli/user.ts create          --email a@b.c --password 'secret' --role admin|viewer
bun run cli/user.ts delete          --email a@b.c
bun run cli/user.ts list            [--json]
bun run cli/user.ts change-role     --email a@b.c --role admin|viewer
bun run cli/user.ts change-password --email a@b.c --password 'secret'
```

A password given on the command line is visible to other users through `ps` and
is written to your shell history. Where that matters, pipe it in instead:

```bash
printf '%s' "$PASSWORD" | bun run cli/user.ts create --email a@b.c --password-stdin --role viewer
```

Changing a password or a role signs that account out everywhere.

**Roles**

| | Viewer | Administrator |
|---|:---:|:---:|
| Browse, search, view, download | ✅ | ✅ |
| Upload, edit, delete | — | ✅ |

## Using the app

**Uploading.** PNG, JPG, and WEBP are accepted. Every upload is converted to
**lossless** WEBP, so changing format costs no quality, and is stored under a
fresh UUID v4. A thumbnail is generated alongside it.

**Grid geometry.** If a map has a painted grid, record the pixels per square
(*grid size*) and how many squares fit across and down. Fill in any one of the
three and the others are worked out for you — enter a grid size of 70 on a
1400×980 map and it records 20×14 squares. On the map's page, *Show grid
overlay* draws the recorded grid over the image so you can check it lines up.

Square counts rarely divide an image evenly: 30 squares across a 1000px map
works out at 33.33px each, which no file can represent. Rather than round it and
leave the recorded grid describing something the image is not, the image is
enlarged the smallest amount that makes the square size whole — here to 1020px,
with 34px squares. This happens on upload and again on an edit that changes
either square count, and `upscale factor` on the map's page reports the total
enlargement since upload. Counts that disagree about how big a square is are
rejected rather than stretched, and an enlargement beyond `GRID_MAX_UPSCALE` or
`MAX_IMAGE_PIXELS` is declined, leaving the grid size rounded as before.

> Automatic grid detection is specified but **not yet implemented**. Maps
> uploaded with the grid fields blank are saved with no grid recorded, and can
> be edited later to add one. See `src/images/grid.ts`.

**Variants.** A variant is an alternate version of the same map — `day`,
`night`, `flooded`. Maps sharing a name are linked to each other, and each
name/variant pair must be unique.

**Searching.** Search by name, by tags, or both. Tags are lowercase letters
only, separated by spaces or commas. Multiple tags can be matched with *Any*
(OR) or *All* (AND). Everything is case-insensitive, and a search is a
bookmarkable URL.

## Configuration

Every setting is read from the environment; Bun loads `.env` automatically. The
process refuses to start if a value is invalid rather than running misconfigured.
See [`.env.example`](.env.example) for the full annotated list.

The settings most worth reviewing:

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE_DIR` | `./data/images` | Where maps are stored. Must be outside `public/`. |
| `DATABASE_PATH` | `./data/battlemapper.sqlite` | SQLite database file. |
| `MAX_UPLOAD_BYTES` | `25MB` | Largest accepted upload. Accepts a `KB`/`MB`/`GB` suffix. |
| `COOKIE_SECURE` | `true` | Set `false` only when serving over plain HTTP. |
| `TRUST_PROXY` | `false` | Enable behind a reverse proxy so `X-Forwarded-For` is honoured. |
| `PAGE_SIZE` | `24` | Maps per page. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

## Security

The app follows the OWASP Top Ten. In brief:

- **Access control is deny-by-default.** Authentication is applied at the root,
  with an explicit list of public paths, so a newly added route is private until
  someone opts it out. Every mutating route additionally requires an admin.
- **Full-resolution maps require authentication.** `IMAGE_DIR` is never mounted
  statically; the only readers are routes behind the auth middleware. Image
  paths are built from a UUID that has been pattern-matched first, so traversal
  is impossible by construction rather than by filtering.
- **Passwords** are hashed with Argon2id at OWASP's recommended cost. Sign-in is
  rate limited per client *and* per account, and an unknown address costs the
  same time and yields the same message as a wrong password.
- **Sessions** are server-side. The cookie holds a 256-bit random token; only
  its SHA-256 is stored, so a database backup yields no usable sessions. Both an
  idle timeout and an absolute lifetime apply.
- **CSRF protection is two-layered**: origin validation plus a synchroniser
  token in every form, including the sign-in form while signed out.
- **Injection** is prevented by prepared statements throughout. Search terms are
  quoted before reaching FTS5, so operators such as `OR` and `*` are matched as
  text rather than executed. All template output is escaped by default.
- **Uploads** are identified by their leading bytes, not by the filename or the
  browser-supplied content type, and are fully re-encoded — which also strips
  any embedded metadata payload.
- **A strict CSP** with no `unsafe-inline` for scripts or styles. The one
  dynamic style the app needs carries a per-request nonce.

Review dependencies with `bun pm audit`.

### Reporting

If you find a security problem, please report it privately to the maintainer
rather than opening a public issue.

## Development

```bash
bun test          # 129 tests
bun run typecheck # tsc --noEmit
bun run css:watch # rebuild CSS on change
```

### Layout

```
src/
  config.ts     log.ts     errors.ts     server.tsx
  db/           schema and forward-only migrations
  models/       users, maps, tag normalisation, search query builder
  auth/         password hashing, sessions, access-control middleware
  security/     CSRF, response headers, rate limiting
  images/       storage sharding, upload processing, grid geometry
  routes/       auth, maps, admin, files, static
  views/        server-rendered components
cli/user.ts     account management
tests/          unit and end-to-end suites
```

Images are sharded across 256 directories named for the first two characters of
each UUID, so no single directory grows unwieldy:

```
data/images/60/601eece7-4038-4922-9f64-8cc2247f7bd3.webp
data/images/60/601eece7-4038-4922-9f64-8cc2247f7bd3_thumb.webp
```

### Notes on the design

- **No client-side framework.** Pages are server-rendered with `hono/jsx`. The
  app is fully usable with JavaScript disabled; `public/app.js` only adds an
  instant theme switch and a delete confirmation.
- **Light and dark mode need no JavaScript.** A cookie records the preference
  and the server renders the matching class, so the first paint is already
  correct. With no preference set, CSS follows the operating system.
- **Thumbnails are lossy** (quality 90 by default); stored maps never are.

## Deployment

Run behind a reverse proxy that terminates TLS, and set `TRUST_PROXY=true` so
rate limiting sees real client addresses. Back up two things: the SQLite
database and `IMAGE_DIR`.

## License

Not currently licensed for redistribution.
