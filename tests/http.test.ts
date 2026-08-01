/**
 * End-to-end HTTP behaviour: the access-control matrix, CSRF enforcement,
 * search, and the guarantee that full-resolution maps need authentication.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import sharp from 'sharp';

import { assetVersion, PUBLIC_DIR } from '../src/assets.ts';
import { config } from '../src/config.ts';
import { hammingDistance } from '../src/images/fingerprint.ts';
import { FORMAT_LABELS, FORMAT_MIME_TYPES } from '../src/images/process.ts';
import { fullImagePath, STORAGE_EXTENSIONS, thumbImagePath } from '../src/images/storage.ts';
import { createMap, findMap } from '../src/models/maps.ts';
import { Client, ensureSchema, makeMapPng, makeUser, signedInAs, uploadForm, uuidFromRedirect } from './helpers.ts';

/** The escaped form a Tailwind class name takes inside a CSS selector. */
const escapeClassName = (name: string): string => name.replace(/[:/.[\]%]/g, (char) => `\\${char}`);

let admin: Client;
let viewer: Client;
let anonymous: Client;
let mapUuid: string;
let png: Buffer;

beforeAll(async () => {
  await ensureSchema();

  admin = await signedInAs('admin');
  viewer = await signedInAs('viewer');
  anonymous = new Client();
  png = await makeMapPng(280, 210, 70);

  const response = await admin.post(
    '/maps/new',
    uploadForm(await admin.csrfToken(), png, {
      name: 'Fixture River Crossing',
      variant: 'day',
      tags: 'forest road water',
      gridSize: '70',
    }),
  );
  mapUuid = uuidFromRedirect(response);
  expect(mapUuid).toMatch(/^[0-9a-f-]{36}$/);
});

describe('access control', () => {
  test('anonymous visitors are sent to sign in, never served the page', async () => {
    for (const path of ['/maps', `/maps/${mapUuid}`, '/maps/new']) {
      const response = await anonymous.get(path);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toStartWith('/login');
    }
  });

  test('anonymous visitors cannot reach a full-resolution map by any route', async () => {
    for (const variant of ['full', 'thumb', 'download']) {
      const response = await anonymous.get(`/i/${mapUuid}/${variant}`);
      expect(response.status).toBe(302);
      // Critically: no image bytes in the body.
      expect((await response.arrayBuffer()).byteLength).toBeLessThan(2048);
      expect(response.headers.get('content-type')).not.toBe(FORMAT_MIME_TYPES[config.image.format]);
    }
  });

  test('viewers can read maps and images', async () => {
    expect((await viewer.get('/maps')).status).toBe(200);
    expect((await viewer.get(`/maps/${mapUuid}`)).status).toBe(200);

    const image = await viewer.get(`/i/${mapUuid}/full`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe(FORMAT_MIME_TYPES[config.image.format]);
  });

  test('viewers are refused every write route, not merely denied the buttons', async () => {
    const token = await viewer.csrfToken();

    expect((await viewer.get('/maps/new')).status).toBe(403);
    expect((await viewer.get(`/maps/${mapUuid}/edit`)).status).toBe(403);
    expect((await viewer.post(`/maps/${mapUuid}/delete`, new URLSearchParams({ _csrf: token }))).status).toBe(403);
    expect((await viewer.post('/maps/new', uploadForm(token, png))).status).toBe(403);
    expect(
      (await viewer.post(`/maps/${mapUuid}/edit`, new URLSearchParams({ _csrf: token, name: 'Hijacked' }))).status,
    ).toBe(403);
  });

  test('the viewer listing offers no upload affordance', async () => {
    expect(await (await viewer.get('/maps')).text()).not.toContain('/maps/new');
  });

  test('admins can reach the write routes', async () => {
    expect((await admin.get('/maps/new')).status).toBe(200);
    expect((await admin.get(`/maps/${mapUuid}/edit`)).status).toBe(200);
  });

  test('a signed-out session cannot be replayed', async () => {
    const client = await signedInAs('viewer');
    expect((await client.get('/maps')).status).toBe(200);

    await client.post('/logout', new URLSearchParams({ _csrf: await client.csrfToken() }));
    expect((await client.get('/maps')).status).toBe(302);
  });
});

describe('CSRF', () => {
  test('a write without a token is refused', async () => {
    const response = await admin.post(`/maps/${mapUuid}/edit`, new URLSearchParams({ name: 'No Token' }));
    expect(response.status).toBe(403);
  });

  test('a write with the wrong token is refused', async () => {
    const response = await admin.post(
      `/maps/${mapUuid}/edit`,
      new URLSearchParams({ _csrf: 'not-the-right-token', name: 'Bad Token' }),
    );
    expect(response.status).toBe(403);
  });

  test('one session cannot use another session token', async () => {
    const other = await signedInAs('admin');
    const stolen = await other.csrfToken();

    const response = await admin.post(
      `/maps/${mapUuid}/edit`,
      new URLSearchParams({ _csrf: stolen, name: 'Cross Session' }),
    );
    expect(response.status).toBe(403);
  });

  test('a cross-origin write is refused before the token is even considered', async () => {
    const response = await admin.post(
      `/maps/${mapUuid}/edit`,
      new URLSearchParams({ _csrf: await admin.csrfToken(), name: 'Evil' }),
      { headers: { Origin: 'https://evil.example' } },
    );
    expect(response.status).toBe(403);
  });

  test('the login form itself is CSRF-protected while signed out', async () => {
    const { email, password } = await makeUser('viewer');
    const client = new Client();
    await client.get('/login');

    const withoutToken = await client.post('/login', new URLSearchParams({ email, password }));
    expect(withoutToken.status).toBe(403);

    // The same request with a valid token succeeds, proving the token is what
    // was missing rather than the credentials.
    const token = await client.csrfToken('/login');
    const withToken = await client.post('/login', new URLSearchParams({ _csrf: token, email, password }));
    expect(withToken.status).toBe(302);
  });

  test('safe methods are never blocked', async () => {
    expect((await admin.get('/maps')).status).toBe(200);
  });
});

describe('login', () => {
  test('a wrong password is refused with a message that does not confirm the account', async () => {
    const { email } = await makeUser('viewer');
    const client = new Client();
    const response = await client.post(
      '/login',
      new URLSearchParams({ _csrf: await client.csrfToken('/login'), email, password: 'wrong password entirely' }),
    );

    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain('not correct');
    // The same wording must be used for an unknown address.
    const unknown = new Client();
    const unknownResponse = await unknown.post(
      '/login',
      new URLSearchParams({
        _csrf: await unknown.csrfToken('/login'),
        email: 'nobody-at-all@example.test',
        password: 'wrong password entirely',
      }),
    );
    expect(await unknownResponse.text()).toContain('not correct');
    expect(unknownResponse.status).toBe(401);
  });
});

describe('search', () => {
  const search = async (query: string): Promise<string> => (await admin.get(`/maps?${query}`)).text();
  const matches = (html: string, name: string): boolean => html.includes(name);

  test('finds a map by name, case-insensitively', async () => {
    expect(matches(await search('q=fixture+river'), 'Fixture River Crossing')).toBe(true);
    expect(matches(await search('q=FIXTURE+RIVER'), 'Fixture River Crossing')).toBe(true);
  });

  test('prefix-matches the final word', async () => {
    expect(matches(await search('q=fixture+riv'), 'Fixture River Crossing')).toBe(true);
  });

  test('finds a map by tag, case-insensitively', async () => {
    expect(matches(await search('tags=forest'), 'Fixture River Crossing')).toBe(true);
    expect(matches(await search('tags=FOREST'), 'Fixture River Crossing')).toBe(true);
  });

  test('AND mode requires every tag; OR mode requires only one', async () => {
    expect(matches(await search('tags=forest+road&mode=all'), 'Fixture River Crossing')).toBe(true);
    expect(matches(await search('tags=forest+nonexistenttag&mode=all'), 'Fixture River Crossing')).toBe(false);
    expect(matches(await search('tags=forest+nonexistenttag&mode=any'), 'Fixture River Crossing')).toBe(true);
  });

  test('FTS operators in user input are treated as text, not syntax', async () => {
    for (const query of ['q=forest+OR+*', 'q=%22', 'q=NEAR%2F2', 'tags=*', 'q=%29%28', 'q=a%22+OR+%22b']) {
      const response = await admin.get(`/maps?${query}`);
      expect(response.status).toBe(200);
    }
  });

  test('an unmatched search reports an empty state rather than an error', async () => {
    const html = await search('q=definitelynosuchmapname');
    expect(html).toContain('No maps match that search');
  });
});

describe('map lifecycle', () => {
  test('upload derives the square counts from the grid size', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Lifecycle Derivation', gridSize: '70' }),
    );
    const uuid = uuidFromRedirect(response);

    const html = await (await admin.get(`/maps/${uuid}`)).text();
    expect(html).toContain('70 px per square');
    expect(html).toContain('Entered manually');
  });

  test('the upload form leaves the name optional and tags the file input for app.js', async () => {
    const html = await (await admin.get('/maps/new')).text();

    // The hook public/app.js listens for, and the absence of `required` that
    // lets a JS-less admin submit a blank name for the server to derive.
    expect(html).toContain('data-name-from-file');
    expect(html).toMatch(/<input[^>]*id="name"[^>]*>/);
    expect(html.match(/<input[^>]*id="name"[^>]*>/)![0]).not.toContain('required');
  });

  test('the upload form offers a drop target carrying its own active classes', async () => {
    const html = await (await admin.get('/maps/new')).text();

    expect(html).toContain('data-dropzone');
    expect(html).toContain('data-dropzone-message');
    // app.js reads the highlight classes from here rather than naming them, so
    // an empty attribute would leave a drop with no visible feedback.
    const active = html.match(/data-dropzone-active="([^"]+)"/);
    expect(active?.[1]).toBeTruthy();

    // Every one of them has to survive the Tailwind build to have any effect.
    const css = await Bun.file('public/app.css').text();
    for (const name of active![1]!.split(' ')) {
      expect(css).toContain(escapeClassName(name));
    }
  });

  test('an upload with no name is named after the file', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: '' }, 'Lifecycle_sunken-temple 02.png'),
    );
    const uuid = uuidFromRedirect(response);

    expect(findMap(uuid)!.name).toBe('Lifecycle Sunken Temple 02');
  });

  test('a name that was typed wins over the file name', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Lifecycle Typed Name' }, 'ignored_file.png'),
    );

    expect(findMap(uuidFromRedirect(response))!.name).toBe('Lifecycle Typed Name');
  });

  test('a nameless upload with a bad tag comes back showing the derived name', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: '', tags: '123' }, 'Lifecycle_rejected.png'),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('value="Lifecycle Rejected"');
  });

  test('square counts in the file name become the grid, and leave the name clean', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(
        await admin.csrfToken(),
        await makeMapPng(400, 300, 10),
        { name: '', gridSize: '', gridWidth: '', gridHeight: '' },
        'Lifecycle Named Grid 40x30.png',
      ),
    );

    const map = findMap(uuidFromRedirect(response))!;
    expect(map.name).toBe('Lifecycle Named Grid');
    expect(map).toMatchObject({ gridWidth: 40, gridHeight: 30, gridSize: 10 });
  });

  test('anything typed into the grid outranks the file name', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(
        await admin.csrfToken(),
        await makeMapPng(400, 300, 10),
        { name: 'Lifecycle Typed Grid', gridSize: '20' },
        'ignored 40x30.png',
      ),
    );

    // The grid size the admin typed decides the counts; the file name is not
    // allowed to contradict it.
    expect(findMap(uuidFromRedirect(response))!).toMatchObject({ gridSize: 20, gridWidth: 20, gridHeight: 15 });
  });

  test('a resolution in the file name is not mistaken for a grid', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: '' }, 'Lifecycle Resolution 1920x1080.png'),
    );

    const map = findMap(uuidFromRedirect(response))!;
    expect(map.gridWidth).toBeNull();
    expect(map.name).toBe('Lifecycle Resolution 1920x1080');
  });

  test('a map uploaded with no grid says so and offers to add one', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Lifecycle No Grid' }),
    );
    const html = await (await admin.get(`/maps/${uuidFromRedirect(response)}`)).text();
    expect(html).toContain('No grid recorded');
  });

  test('editing can add a grid afterwards', async () => {
    const created = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Lifecycle Edit Target' }),
    );
    const uuid = uuidFromRedirect(created);

    await admin.post(
      `/maps/${uuid}/edit`,
      new URLSearchParams({
        _csrf: await admin.csrfToken(),
        name: 'Lifecycle Edit Target',
        variant: '',
        tags: 'cave',
        gridSize: '70',
        gridWidth: '',
        gridHeight: '',
      }),
    );

    const html = await (await admin.get(`/maps/${uuid}`)).text();
    expect(html).toContain('70 px per square');
    expect(html).toContain('cave');
  });

  test('square counts that do not divide the image enlarge it on upload', async () => {
    const square = await makeMapPng(1000, 1000, 100);
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), square, {
        name: 'Lifecycle Upscale',
        gridWidth: '30',
        gridHeight: '30',
      }),
    );
    const uuid = uuidFromRedirect(response);

    const map = findMap(uuid)!;
    expect(map).toMatchObject({ gridSize: 34, gridWidth: 30, gridHeight: 30, imageWidth: 1020, imageHeight: 1020 });
    expect(map.upscaleFactor).toBeCloseTo(1.02, 6);

    const stored = await sharp(await (await admin.get(`/i/${uuid}/full`)).arrayBuffer()).metadata();
    expect(stored.width).toBe(1020);
  });

  test('changing the square counts on an edit re-scales the stored image', async () => {
    const square = await makeMapPng(1000, 1000, 100);
    const created = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), square, {
        name: 'Lifecycle Upscale Edit',
        gridWidth: '30',
        gridHeight: '30',
      }),
    );
    const uuid = uuidFromRedirect(created);
    const afterUpload = findMap(uuid)!;
    expect(afterUpload.imageWidth).toBe(1020);

    // The form posts back every field, including the grid size the upload
    // recorded — the changed counts must win over it.
    await admin.post(
      `/maps/${uuid}/edit`,
      new URLSearchParams({
        _csrf: await admin.csrfToken(),
        name: 'Lifecycle Upscale Edit',
        variant: '',
        tags: '',
        gridSize: '34',
        gridWidth: '25',
        gridHeight: '25',
      }),
    );

    const edited = findMap(uuid)!;
    expect(edited).toMatchObject({ gridSize: 41, gridWidth: 25, gridHeight: 25, imageWidth: 1025, imageHeight: 1025 });
    // Cumulative against the original 1000px upload, not the 1020px file.
    expect(edited.upscaleFactor).toBeCloseTo((1020 / 1000) * (1025 / 1020), 6);
    expect(edited.fileSize).not.toBe(afterUpload.fileSize);

    const stored = await sharp(await (await admin.get(`/i/${uuid}/full`)).arrayBuffer()).metadata();
    expect(stored.width).toBe(1025);
    expect(stored.height).toBe(1025);
  });

  test('an edit that leaves the grid alone does not touch the image', async () => {
    const square = await makeMapPng(1000, 1000, 100);
    const created = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), square, { name: 'Lifecycle Untouched', gridWidth: '30', gridHeight: '30' }),
    );
    const uuid = uuidFromRedirect(created);
    const before = findMap(uuid)!;

    await admin.post(
      `/maps/${uuid}/edit`,
      new URLSearchParams({
        _csrf: await admin.csrfToken(),
        name: 'Lifecycle Untouched Renamed',
        variant: '',
        tags: 'cave',
        gridSize: String(before.gridSize),
        gridWidth: String(before.gridWidth),
        gridHeight: String(before.gridHeight),
      }),
    );

    const after = findMap(uuid)!;
    expect(after.name).toBe('Lifecycle Untouched Renamed');
    expect(after).toMatchObject({
      gridSize: before.gridSize,
      imageWidth: before.imageWidth,
      imageHeight: before.imageHeight,
      fileSize: before.fileSize,
      upscaleFactor: before.upscaleFactor,
    });
  });

  test('square counts that disagree about the square size are rejected', async () => {
    const wide = await makeMapPng(1000, 800, 100);
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), wide, {
        name: 'Lifecycle Disagreement',
        gridWidth: '30',
        gridHeight: '30',
      }),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('Squares are square');
    // The form comes back with the values intact rather than a blank slate.
    expect(html).toContain('Lifecycle Disagreement');
  });

  test('a duplicate name and variant is refused with a helpful message', async () => {
    // A visually distinct image, so this stays a test of the name/variant
    // constraint rather than tripping the near-duplicate check first.
    const form = uploadForm(await admin.csrfToken(), await makeMapPng(), {
      name: 'Fixture River Crossing',
      variant: 'day',
    });
    const response = await admin.post('/maps/new', form);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('already has a');
  });

  test('the same name with a different variant is allowed and links as a sibling', async () => {
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Fixture River Crossing', variant: 'night' }),
    );
    expect(response.status).toBe(302);

    const html = await (await admin.get(`/maps/${mapUuid}`)).text();
    expect(html).toContain('Other variants');
    expect(html).toContain('night');
  });

  test('delete removes the map and its images', async () => {
    const created = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Lifecycle Delete Target' }),
    );
    const uuid = uuidFromRedirect(created);

    expect((await admin.get(`/i/${uuid}/full`)).status).toBe(200);

    const deleted = await admin.post(`/maps/${uuid}/delete`, new URLSearchParams({ _csrf: await admin.csrfToken() }));
    expect(deleted.status).toBe(302);

    expect((await admin.get(`/maps/${uuid}`)).status).toBe(404);
    expect((await admin.get(`/i/${uuid}/full`)).status).toBe(404);
  });
});

/**
 * Written against `config.image` rather than a hard-coded WEBP, so the same
 * assertions hold whichever format the suite is run under:
 * `IMAGE_FORMAT=png bun test` and `IMAGE_FORMAT=jpeg IMAGE_QUALITY=85 bun test`
 * exercise the other branches of this end to end.
 */
describe('storage format', () => {
  test('one format describes the row, the files, and every response', async () => {
    const created = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(280, 210, 70), { name: 'Storage Format', gridSize: '70' }),
    );
    const uuid = uuidFromRedirect(created);
    const map = findMap(uuid)!;
    const { format } = config.image;

    expect(map.format).toBe(format);
    expect(await Bun.file(fullImagePath(uuid, format)).exists()).toBe(true);
    expect(await Bun.file(thumbImagePath(uuid, format)).exists()).toBe(true);
    expect((await sharp(fullImagePath(uuid, format)).metadata()).format).toBe(format);

    expect((await admin.get(`/i/${uuid}/full`)).headers.get('content-type')).toBe(FORMAT_MIME_TYPES[format]);
    expect((await admin.get(`/i/${uuid}/thumb`)).headers.get('content-type')).toBe(FORMAT_MIME_TYPES[format]);

    const download = await admin.get(`/i/${uuid}/download`);
    expect(download.headers.get('content-disposition')).toContain(`${STORAGE_EXTENSIONS[format]}"`);

    // And the detail page names the format the file actually is.
    expect(await (await admin.get(`/maps/${uuid}`)).text()).toContain(FORMAT_LABELS[format]);
  });

  test('an edit that rescales keeps the map in the format it was stored in', async () => {
    const created = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(1000, 1000, 100), { name: 'Storage Format Edit' }),
    );
    const uuid = uuidFromRedirect(created);
    const { format } = findMap(uuid)!;

    await admin.post(
      `/maps/${uuid}/edit`,
      new URLSearchParams({
        _csrf: await admin.csrfToken(),
        name: 'Storage Format Edit',
        variant: '',
        tags: '',
        gridSize: '',
        gridWidth: '30',
        gridHeight: '30',
      }),
    );

    const edited = findMap(uuid)!;
    expect(edited.format).toBe(format);
    expect(edited.imageWidth).toBe(1020);
    // Written under the same name, so the rescale did not leave the old file
    // behind under a different extension.
    expect((await sharp(fullImagePath(uuid, format)).metadata()).width).toBe(1020);
  });
});

describe('map detail', () => {
  test('the map opens full size on click, with no script involved', async () => {
    const html = await (await admin.get(`/maps/${mapUuid}`)).text();

    // A checkbox and two labels for it: one around the image to open the view,
    // one covering the screen to close it again.
    expect(html).toContain('id="full-size"');
    expect(html.match(/for="full-size"/g)).toHaveLength(2);
    // Which is what makes it full size rather than a second fitted copy.
    expect(html).toContain('max-w-none');

    // The grid toggle is a second checkbox on the same page; both must survive.
    expect(html).toContain('id="grid-toggle"');
  });

  test('reports when a map was added to the minute, not just the day', async () => {
    const map = findMap(mapUuid)!;
    const html = await (await admin.get(`/maps/${mapUuid}`)).text();

    const iso = new Date(map.createdAt).toISOString();
    // The machine-readable instant, for app.js to restate in the local zone…
    expect(html).toContain(`<time datetime="${iso}" data-local-time`);
    // …and a reading that stands on its own with JavaScript off, saying plainly
    // which zone it is in.
    expect(html).toContain(`${iso.slice(0, 16).replace('T', ' ')} UTC`);
    expect(html).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  test('the page freeze behind the full-size view survives the CSS build', async () => {
    const css = await Bun.file('public/app.css').text();
    expect(css).toContain('body:has([data-lightbox-toggle]:checked)');
  });
});

describe('duplicate detection', () => {
  /** Uploads an image and returns the response, without asserting what it is. */
  const upload = (client: Client, image: Buffer, overrides: Record<string, string> = {}) =>
    client.csrfToken().then((token) => client.post('/maps/new', uploadForm(token, image, overrides)));

  /** Pulls the staged UUID back out of the confirmation form. */
  const stagedUuidFrom = (html: string): string =>
    /name="pendingUuid" value="([0-9a-f-]{36})"/.exec(html)?.[1] ?? '';

  const confirm = async (client: Client, pendingUuid: string, fields: Record<string, string>) => {
    const body = new URLSearchParams({
      _csrf: await client.csrfToken(),
      pendingUuid,
      name: '',
      variant: '',
      tags: '',
      ...fields,
    });
    return client.post('/maps/new', body);
  };

  test('a re-upload of the same image is held back and shows what it matched', async () => {
    const image = await makeMapPng(400, 300, 50);
    const first = await upload(admin, image, { name: 'Sunken Chapel' });
    expect(first.status).toBe(302);

    const second = await upload(admin, image, { name: 'Something Else Entirely' });

    // Not a redirect: nothing was created.
    expect(second.status).toBe(200);
    const html = await second.text();
    expect(html).toContain('This looks like a map you already have');
    // The matching map is shown, thumbnail and all.
    expect(html).toContain(`/i/${uuidFromRedirect(first)}/thumb`);
    expect(html).toContain('Identical');
    // And the name field is pre-filled from it, not from what was typed.
    expect(html).toContain('value="Sunken Chapel"');
    expect(html).not.toContain('Something Else Entirely');
  });

  test('the staged image is previewed, and only to the admin who staged it', async () => {
    const image = await makeMapPng(400, 300, 50);
    await upload(admin, image, { name: 'Preview Source' });
    const staged = stagedUuidFrom(await (await upload(admin, image, { name: 'Preview Source' })).text());

    expect((await admin.get(`/i/pending/${staged}/thumb`)).status).toBe(200);

    // A viewer has no business seeing an image the library has not accepted.
    expect((await viewer.get(`/i/pending/${staged}/thumb`)).status).toBe(403);

    // Nor does another admin, even knowing the UUID.
    const otherAdmin = await signedInAs('admin');
    expect((await otherAdmin.get(`/i/pending/${staged}/thumb`)).status).toBe(404);
  });

  test('confirming with a variant saves it alongside the map it matched', async () => {
    const image = await makeMapPng(400, 300, 50);
    const original = uuidFromRedirect(await upload(admin, image, { name: 'Bandit Camp' }));
    const staged = stagedUuidFrom(await (await upload(admin, image, { name: 'Bandit Camp' })).text());

    const saved = await confirm(admin, staged, { name: 'Bandit Camp', variant: 'night' });
    expect(saved.status).toBe(302);

    // It kept the UUID its files were written under, so nothing was re-encoded.
    expect(uuidFromRedirect(saved)).toBe(staged);
    expect(findMap(staged)?.variant).toBe('night');

    const html = await (await admin.get(`/maps/${original}`)).text();
    expect(html).toContain('Other variants');
    expect(html).toContain('night');
  });

  test('confirming without a variant explains the clash and keeps the form usable', async () => {
    const image = await makeMapPng(400, 300, 50);
    await upload(admin, image, { name: 'Toll Bridge' });
    const staged = stagedUuidFrom(await (await upload(admin, image, { name: 'Toll Bridge' })).text());

    const clash = await confirm(admin, staged, { name: 'Toll Bridge', variant: '' });
    expect(clash.status).toBe(409);

    const html = await clash.text();
    expect(html).toContain('already exists');
    // The upload is not stranded: the matches and the staged UUID come back.
    expect(html).toContain('This looks like a map you already have');
    expect(stagedUuidFrom(html)).toBe(staged);

    // And it can still be saved once a variant is supplied.
    expect((await confirm(admin, staged, { name: 'Toll Bridge', variant: 'flooded' })).status).toBe(302);
  });

  test('discarding removes the staged row and both files', async () => {
    const image = await makeMapPng(400, 300, 50);
    await upload(admin, image, { name: 'Discarded Ruin' });
    const staged = stagedUuidFrom(await (await upload(admin, image, { name: 'Discarded Ruin' })).text());

    expect((await admin.get(`/i/pending/${staged}/thumb`)).status).toBe(200);

    const discarded = await confirm(admin, staged, { action: 'discard' });
    expect(discarded.status).toBe(302);
    expect(discarded.headers.get('location')).toBe('/maps/new');

    expect(findMap(staged)).toBeNull();
    expect((await admin.get(`/i/pending/${staged}/thumb`)).status).toBe(404);
    expect(await Bun.file(fullImagePath(staged, config.image.format)).exists()).toBe(false);
    expect(await Bun.file(thumbImagePath(staged, config.image.format)).exists()).toBe(false);
  });

  test('a staged upload belonging to another admin cannot be committed', async () => {
    const image = await makeMapPng(400, 300, 50);
    await upload(admin, image, { name: 'Borrowed Keep' });
    const staged = stagedUuidFrom(await (await upload(admin, image, { name: 'Borrowed Keep' })).text());

    const thief = await signedInAs('admin');
    const stolen = await confirm(thief, staged, { name: 'Borrowed Keep', variant: 'stolen' });

    expect(stolen.status).toBe(404);
    expect(findMap(staged)).toBeNull();

    // Still the original admin's to save.
    expect((await confirm(admin, staged, { name: 'Borrowed Keep', variant: 'mine' })).status).toBe(302);
  });

  test('a visibly different map is uploaded without a word about duplicates', async () => {
    await upload(admin, await makeMapPng(400, 300, 50), { name: 'Unrelated One' });
    const response = await upload(admin, await makeMapPng(400, 300, 50), { name: 'Unrelated Two' });

    expect(response.status).toBe(302);
  });

  test('the fingerprint is recorded, and follows the image when an edit resizes it', async () => {
    const created = await upload(admin, await makeMapPng(1000, 1000, 100), { name: 'Resized Fingerprint' });
    const uuid = uuidFromRedirect(created);
    const before = findMap(uuid)!.fingerprint!;
    expect(before).toMatch(/^[0-9a-f]{16}$/);

    // 30 squares across 1000px does not divide evenly, so the image is enlarged.
    await admin.post(
      `/maps/${uuid}/edit`,
      new URLSearchParams({
        _csrf: await admin.csrfToken(),
        name: 'Resized Fingerprint',
        variant: '',
        tags: '',
        gridSize: '',
        gridWidth: '30',
        gridHeight: '30',
      }),
    );

    const after = findMap(uuid)!;
    expect(after.imageWidth).toBe(1020);
    // Re-taken from the new pixels, and still recognisably the same map.
    expect(after.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(before, after.fingerprint!)).toBeLessThanOrEqual(8);
  });
});

describe('image delivery', () => {
  test('sets a download filename and a length', async () => {
    const response = await admin.get(`/i/${mapUuid}/download`);
    const disposition = response.headers.get('content-disposition');

    expect(disposition).toContain('attachment');
    // Name, then variant, then enough of the map's own identifier that no two
    // maps can land on the same filename.
    expect(disposition).toContain(
      `filename="fixture-river-crossing-day-${mapUuid.slice(0, 8)}${STORAGE_EXTENSIONS[config.image.format]}"`,
    );
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0);
  });

  test('two variants of one map download under different names', async () => {
    const upload = async (variant: string): Promise<string> => {
      const response = await admin.post(
        '/maps/new',
        uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Download Naming', variant }),
      );
      expect(response.status).toBe(302);
      return uuidFromRedirect(response);
    };

    const dawn = await admin.get(`/i/${await upload('dawn')}/download`);
    const dusk = await admin.get(`/i/${await upload('dusk')}/download`);

    expect(dawn.headers.get('content-disposition')).toContain('download-naming-dawn');
    expect(dusk.headers.get('content-disposition')).toContain('download-naming-dusk');
    expect(dawn.headers.get('content-disposition')).not.toBe(dusk.headers.get('content-disposition'));
  });

  test('marks authenticated images private so no shared cache retains them', async () => {
    const response = await admin.get(`/i/${mapUuid}/full`);
    expect(response.headers.get('cache-control')).toContain('private');
  });

  test('rejects a path that is not a UUID', async () => {
    for (const bad of ['../../../etc/passwd', 'not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      expect((await admin.get(`/i/${encodeURIComponent(bad)}/full`)).status).toBe(404);
    }
  });
});

describe('static assets', () => {
  test('are linked with a stamp, so an edited file is not served from cache', async () => {
    const html = await (await admin.get('/maps/new')).text();

    const script = html.match(/<script src="\/app\.js\?v=([^"]+)"/);
    const style = html.match(/<link rel="stylesheet" href="\/app\.css\?v=([^"]+)"/);
    expect(script?.[1]).toBeTruthy();
    expect(style?.[1]).toBeTruthy();

    // The stamp follows the file, so touching it changes the URL the browser
    // asks for — which is the whole point of stamping it.
    expect(script![1]).toBe(assetVersion('app.js'));
    expect(style![1]).toBe(assetVersion('app.css'));
  });

  test('are still served, and still public, with the stamp on the URL', async () => {
    for (const path of ['/app.js', '/app.css']) {
      const stamped = await anonymous.get(`${path}?v=${assetVersion(path === '/app.js' ? 'app.js' : 'app.css')}`);
      expect(stamped.status).toBe(200);
      expect(stamped.headers.get('cache-control')).toContain('max-age=86400');
    }
  });

  test('the stamp changes when the file does', async () => {
    const before = assetVersion('app.js');

    const path = `${PUBLIC_DIR}/app.js`;
    const original = await Bun.file(path).text();
    try {
      await Bun.write(path, `${original}\n// touched by a test\n`);
      expect(assetVersion('app.js')).not.toBe(before);
    } finally {
      await Bun.write(path, original);
    }
  });
});

describe('security headers', () => {
  test('every response carries the hardening headers', async () => {
    const response = await admin.get('/maps');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');

    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The relaxations that would undo the policy must not be present.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  test('the nonce in the policy is the one the page actually uses', async () => {
    const response = await admin.get(`/maps/${mapUuid}`);
    const html = await response.text();

    const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  test('a fresh nonce is issued per request', async () => {
    const first = (await admin.get(`/maps/${mapUuid}`)).headers.get('content-security-policy');
    const second = (await admin.get(`/maps/${mapUuid}`)).headers.get('content-security-policy');
    expect(first).not.toBe(second);
  });
});

describe('output escaping', () => {
  test('a map name containing markup is rendered as text', async () => {
    const hostile = 'XSS <script>alert(1)</script> & "quoted"';
    const response = await admin.post(
      '/maps/new',
      uploadForm(await admin.csrfToken(), await makeMapPng(), { name: hostile }),
    );

    const html = await (await admin.get(`/maps/${uuidFromRedirect(response)}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('error pages', () => {
  test('an unknown path renders a friendly 404 with a reference id', async () => {
    const response = await admin.get('/no/such/page');
    expect(response.status).toBe(404);

    const html = await response.text();
    expect(html).toContain('Nothing here');
    expect(html).toContain('quote reference');
  });

  test('an unknown map renders 404 rather than leaking whether it ever existed', async () => {
    expect((await admin.get('/maps/11111111-1111-4111-8111-111111111111')).status).toBe(404);
  });
});

describe('pagination', () => {
  const PER_PAGE = 24;
  const TAG = 'paginationfixture';

  beforeAll(() => {
    // Rows are inserted directly: pagination is about counting and slicing, and
    // encoding 30 real images would only slow the suite down.
    for (let i = 1; i <= 30; i++) {
      createMap({
        uuid: crypto.randomUUID(),
        name: `Pagination Fixture ${String(i).padStart(2, '0')}`,
        variant: '',
        format: 'webp',
        tags: [TAG],
        gridSize: null,
        gridWidth: null,
        gridHeight: null,
        gridSource: 'none',
        upscaleFactor: 1,
        imageWidth: 100,
        imageHeight: 100,
        fileSize: 1,
        // No image was encoded, so there is nothing to fingerprint — the same
        // state as a map uploaded before fingerprinting existed.
        fingerprint: null,
        originalFilename: null,
        uploadedBy: null,
      });
    }
  });

  const cardCount = (html: string): number => (html.match(/alt="Thumbnail of/g) ?? []).length;

  test('fills the first page and puts the remainder on the second', async () => {
    const first = await (await admin.get(`/maps?tags=${TAG}`)).text();
    const second = await (await admin.get(`/maps?tags=${TAG}&page=2`)).text();

    expect(cardCount(first)).toBe(PER_PAGE);
    expect(cardCount(second)).toBe(30 - PER_PAGE);
    expect(first).toContain('Page 1 of 2');
  });

  test('a page beyond the end clamps to the last page rather than erroring', async () => {
    const response = await admin.get(`/maps?tags=${TAG}&page=999`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Page 2 of 2');
  });

  test('a nonsensical page parameter falls back to the first page', async () => {
    for (const page of ['0', '-3', 'abc', '1e9']) {
      const response = await admin.get(`/maps?tags=${TAG}&page=${page}`);
      expect(response.status).toBe(200);
    }
  });

  test('page links carry the current search with them', async () => {
    const html = await (await admin.get(`/maps?tags=${TAG}`)).text();
    expect(html).toContain(`/maps?tags=${TAG}&amp;page=2`);
  });

  test('sorting by name orders the results', async () => {
    const html = await (await admin.get(`/maps?tags=${TAG}&sort=name`)).text();
    const names = [...html.matchAll(/Pagination Fixture (\d+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(1);
    expect([...names]).toEqual([...names].sort());
  });
});

describe('theme', () => {
  test('defaults to following the system, with no class pinned', async () => {
    const html = await (await (new Client()).get('/login')).text();
    expect(html).toContain('<html lang="en">');
  });

  test('a stored preference is rendered server-side, so there is no flash', async () => {
    const client = new Client();
    await client.get('/login');
    await client.post('/theme', new URLSearchParams({ _csrf: await client.csrfToken('/login'), theme: 'dark' }));

    expect(await (await client.get('/login')).text()).toContain('<html lang="en" class="dark">');
  });
});
