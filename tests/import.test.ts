/**
 * Importing a map from a pasted address, end to end.
 *
 * The download is the only part that cannot happen for real, so it is the only
 * part that is stubbed — and it is stubbed at `fetchRemoteImage`, which means
 * everything the route does with the bytes afterwards is the real thing. The
 * guard inside that function is not exercised here; `websearch.test.ts` owns it,
 * with the DNS resolver injected, because a stubbed `fetch` proves nothing about
 * an address check that happens before the fetch.
 *
 * The mock keeps every other export and falls back to the real function when a
 * test has queued nothing, so this file cannot change how another one behaves
 * even if the module mock outlives it.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

/** What the next download returns, or throws. Null means "call the real one". */
let download: (() => Promise<Uint8Array>) | null = null;

const fetchImageModule = await import('../src/websearch/fetchImage.ts');

// Pulled out before the mock goes in: a module namespace holds live bindings, so
// reading through it afterwards would find the stub and call itself.
const realFetchRemoteImage = fetchImageModule.fetchRemoteImage;

/** The options the route passed, so a test can assert on them. */
let lastOptions: Parameters<typeof realFetchRemoteImage>[1] | null = null;
let lastUrl = '';

mock.module('../src/websearch/fetchImage.ts', () => ({
  ...fetchImageModule,
  fetchRemoteImage: async (...args: Parameters<typeof realFetchRemoteImage>) => {
    lastUrl = args[0];
    lastOptions = args[1];
    return download ? download() : realFetchRemoteImage(...args);
  },
}));

const { Client, ensureSchema, importForm, makeMapPng, makePlainPng, signedInAs, uploadForm, uuidFromRedirect } =
  await import('./helpers.ts');
const { config } = await import('../src/config.ts');
const { findMap } = await import('../src/models/maps.ts');
const { badRequest } = await import('../src/errors.ts');
const { app } = await import('../src/server.tsx');

type TestClient = InstanceType<typeof Client>;

let admin: TestClient;

/** Queues an image for the next download and posts an address to import it from. */
const importFrom = async (
  client: TestClient,
  imageUrl: string,
  image: Buffer,
  fields: Record<string, string> = {},
) => {
  download = async () => new Uint8Array(image);
  return client.post('/maps/new', importForm(await client.csrfToken(), imageUrl, fields));
};

beforeAll(async () => {
  await ensureSchema();
  admin = await signedInAs('admin');
});

afterEach(() => {
  download = null;
  lastOptions = null;
  lastUrl = '';
});

describe('importing from an address', () => {
  test('creates the map and redirects to it, exactly as a file does', async () => {
    const response = await importFrom(
      admin,
      'https://maps.example.org/library/river-ford.png',
      await makeMapPng(280, 210, 70),
      { name: 'Imported River Ford' },
    );

    expect(response.status).toBe(302);
    const map = findMap(uuidFromRedirect(response));
    expect(map).toMatchObject({ name: 'Imported River Ford', imageWidth: 280, imageHeight: 210 });
  });

  test('downloads under the upload limit and the import timeout, not the search settings', async () => {
    await importFrom(admin, 'https://maps.example.org/limits.png', await makeMapPng(), { name: 'Imported Limits' });

    expect(lastUrl).toBe('https://maps.example.org/limits.png');
    expect(lastOptions).toMatchObject({
      maxBytes: config.maxUploadBytes,
      timeoutMs: config.importTimeoutMs,
      // The address was typed by an administrator, so plaintext is allowed here
      // and only here.
      allowInsecure: true,
    });
  });

  test('names the map from the address when the name is left blank', async () => {
    const response = await importFrom(
      admin,
      'https://maps.example.org/library/imported_sunken_chapel.webp',
      await makeMapPng(),
      { name: '' },
    );

    expect(response.status).toBe(302);
    expect(findMap(uuidFromRedirect(response))!.name).toBe('Imported Sunken Chapel');
  });

  test('reads square counts out of the address, as it would out of a file name', async () => {
    const response = await importFrom(
      admin,
      'https://maps.example.org/maps/Imported%20Forest%20Road%2040x30.png',
      await makePlainPng(800, 600),
      { name: '' },
    );

    expect(response.status).toBe(302);
    expect(findMap(uuidFromRedirect(response))).toMatchObject({
      name: 'Imported Forest Road',
      gridWidth: 40,
      gridHeight: 30,
    });
  });

  test('leaves a query string out of the name', async () => {
    const response = await importFrom(
      admin,
      'https://cdn.example.org/imported-marsh-crossing.png?width=1200&cachebust=99x99',
      await makeMapPng(),
      { name: '' },
    );

    expect(response.status).toBe(302);
    expect(findMap(uuidFromRedirect(response))!.name).toBe('Imported Marsh Crossing');
  });

  test('still trips the duplicate check', async () => {
    const twin = await makeMapPng(280, 210, 70, 4242);

    const first = await importFrom(admin, 'https://maps.example.org/twin.png', twin, { name: 'Import Twin' });
    expect(first.status).toBe(302);

    const second = await importFrom(admin, 'https://maps.example.org/twin-again.png', twin, { name: 'Import Twin 2' });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('Import Twin');
  });
});

describe('an address that cannot be used', () => {
  test('comes back as a rejected field with the address still in the form', async () => {
    download = async () => {
      throw badRequest('That image is hosted somewhere this server will not fetch from.');
    };

    const response = await admin.post(
      '/maps/new',
      importForm(await admin.csrfToken(), 'https://internal.example.test/map.png', { name: 'Refused' }),
    );

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('That image is hosted somewhere this server will not fetch from.');
    expect(html).toContain('value="https://internal.example.test/map.png"');
    // The form came back, rather than the error page.
    expect(html).toContain('name="imageUrl"');
  });

  test('is rejected when what arrives is not an image', async () => {
    download = async () => new TextEncoder().encode('<!doctype html><title>Not a map</title>');

    const response = await admin.post(
      '/maps/new',
      importForm(await admin.csrfToken(), 'https://maps.example.org/a-page', { name: 'Not A Map' }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('not a PNG, JPG, or WEBP image');
  });
});

describe('choosing between a file and an address', () => {
  test('refuses a submission carrying both', async () => {
    const form = uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Both At Once' });
    form.set('imageUrl', 'https://maps.example.org/also-this.png');

    const response = await admin.post('/maps/new', form);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Choose a file or paste an address, not both.');
  });

  test('refuses a submission carrying neither', async () => {
    const form = uploadForm(await admin.csrfToken(), await makeMapPng(), { name: 'Neither' });
    form.delete('image');

    const response = await admin.post('/maps/new', form);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('paste the address of one');
  });

  test('refuses an address too long to be a link to an image', async () => {
    const response = await admin.post(
      '/maps/new',
      importForm(await admin.csrfToken(), `https://maps.example.org/${'x'.repeat(2100)}.png`, { name: 'Too Long' }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('too long to be a link');
  });
});
