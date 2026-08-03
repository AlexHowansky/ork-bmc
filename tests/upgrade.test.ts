/**
 * Offering a higher-resolution copy of an upload, end to end.
 *
 * No provider is configured in the test environment, so the search is a no-op
 * unless a test asks for one. Both seams below delegate to the real module until
 * a test queues something, which keeps them from changing the behaviour of any
 * other file if a module mock outlives this one.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

import { db } from '../src/db/index.ts';
import type { UploadCandidateInput } from '../src/models/uploadCandidates.ts';
import { replaceCandidates } from '../src/models/uploadCandidates.ts';
import type { PendingUpload } from '../src/models/pendingUploads.ts';

/** Candidates the next search will "find". Empty means it finds nothing. */
let offered: UploadCandidateInput[] = [];
/** What the next candidate download returns, or throws. */
let download: (() => Promise<Uint8Array>) | null = null;
/** Makes the provider fail. Nothing in this suite may reach the real one. */
let providerFails = false;

const searchModule = await import('../src/websearch/index.ts');
const fetchImageModule = await import('../src/websearch/fetchImage.ts');
const serpapiModule = await import('../src/websearch/serpapi.ts');

// Pulled out into plain references *before* the mocks go in. A module namespace
// holds live bindings, so reading through `searchModule` afterwards would find
// the stub — and a stub that falls back to "the real one" that way calls itself
// until the stack runs out.
const realFindHigherResolution = searchModule.findHigherResolution;
const realFetchRemoteImage = fetchImageModule.fetchRemoteImage;
const realSearch = serpapiModule.search;

// Both mocks keep every other export and fall back to the real behaviour when a
// test has queued nothing, so this file cannot change how another one behaves
// even if a module mock outlives it.
mock.module('../src/websearch/index.ts', () => ({
  ...searchModule,
  findHigherResolution: async (pending: PendingUpload, request: { wanted: boolean }) => {
    if (offered.length === 0 || !request.wanted) return 0;
    replaceCandidates(pending.uuid, offered);
    return offered.length;
  },
}));

mock.module('../src/websearch/fetchImage.ts', () => ({
  ...fetchImageModule,
  fetchRemoteImage: async (...args: Parameters<typeof realFetchRemoteImage>) =>
    download ? download() : realFetchRemoteImage(...args),
}));

// The one test that runs the real orchestrator needs the provider to fail, and
// it has to fail here rather than by being pointed at an unreachable host: a
// search that actually left the machine would spend live API quota from a test
// run. Gated on the flag so the provider's own tests, in another file, still see
// the real thing if this mock outlives this one.
mock.module('../src/websearch/serpapi.ts', () => ({
  ...serpapiModule,
  search: async (...args: Parameters<typeof realSearch>) => {
    if (!providerFails) return realSearch(...args);
    throw new Error('the provider is unavailable');
  },
}));

const { Client, ensureSchema, makeMapPng, signedInAs, uploadForm, uuidFromRedirect } = await import('./helpers.ts');
const { app } = await import('../src/server.tsx');

type TestClient = InstanceType<typeof Client>;

let admin: TestClient;
let otherAdmin: TestClient;
let viewer: TestClient;

const candidate = (over: Partial<UploadCandidateInput> = {}): UploadCandidateInput => ({
  imageUrl: 'https://maps.example.org/full.png',
  pageUrl: 'https://maps.example.org/the-map',
  source: 'maps.example.org',
  title: 'A bigger copy',
  width: 1120,
  height: 840,
  exact: 3,
  thumb: null,
  thumbFormat: null,
  ...over,
});

/**
 * Uploads with the search box ticked, as the form renders it by default.
 *
 * Set explicitly rather than baked into `uploadForm`, because the checkbox only
 * appears when a provider is configured — a browser here would send nothing, and
 * the rest of the suite depends on that staying true.
 */
const upload = async (client: TestClient, image: Buffer, fields: Record<string, string> = {}) => {
  const form = uploadForm(await client.csrfToken(), image, fields);
  form.set('searchWeb', '1');
  return client.post('/maps/new', form);
};

const stagedUuidFrom = (html: string): string =>
  /name="pendingUuid" value="([0-9a-f-]{36})"/.exec(html)?.[1] ?? '';

const candidateIdFrom = (html: string): string => /value="adopt:(\d+)"/.exec(html)?.[1] ?? '';

/** Submits the review form the way the "use this one" button does. */
const act = async (client: TestClient, pendingUuid: string, action: string, fields: Record<string, string> = {}) =>
  client.post(
    '/maps/new',
    new URLSearchParams({
      _csrf: await client.csrfToken(),
      pendingUuid,
      action,
      name: '',
      variant: '',
      tags: '',
      ...fields,
    }),
  );

const pendingRow = (uuid: string) =>
  db.query('SELECT * FROM pending_uploads WHERE uuid = ?').get(uuid) as
    | { image_width: number; image_height: number; fingerprint: string }
    | null;

const candidateCount = (uuid: string) =>
  (db.query('SELECT COUNT(*) AS n FROM upload_candidates WHERE pending_uuid = ?').get(uuid) as { n: number }).n;

beforeAll(async () => {
  await ensureSchema();
  admin = await signedInAs('admin');
  otherAdmin = await signedInAs('admin');
  viewer = await signedInAs('viewer');
});

afterEach(() => {
  offered = [];
  download = null;
  providerFails = false;
});

describe('an upload with nothing to report', () => {
  test('still redirects straight to the new map', async () => {
    const response = await upload(admin, await makeMapPng(280, 210, 70), { name: 'Quiet Hollow' });

    expect(response.status).toBe(302);
    expect(uuidFromRedirect(response)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('leaves nothing staged behind it', async () => {
    // Every upload is staged now, so the row has to be gone again by the time
    // the redirect is issued or the sweep would eventually delete a live map's
    // files out from under it.
    const response = await upload(admin, await makeMapPng(280, 210, 70), { name: 'Empty Crossroads' });

    expect(pendingRow(uuidFromRedirect(response))).toBeNull();
  });
});

describe('when a larger copy is found', () => {
  test('the upload is held and the copy offered', async () => {
    offered = [candidate()];

    const response = await upload(admin, await makeMapPng(280, 210, 70), { name: 'Sunken Chapel' });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('A larger copy of this map is published elsewhere');
    expect(html).toContain('1120 × 840');
    expect(html).toContain('maps.example.org');
    expect(stagedUuidFrom(html)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the offer is skipped when the admin unticked the box', async () => {
    offered = [candidate()];

    // An unticked checkbox submits nothing at all, which is exactly what makes
    // the absence readable as "no".
    const form = uploadForm(await admin.csrfToken(), await makeMapPng(280, 210, 70), { name: 'Unsearched Vale' });

    const response = await admin.post('/maps/new', form);
    expect(response.status).toBe(302);
  });

  test('the map can still be saved as uploaded', async () => {
    offered = [candidate()];

    const staged = stagedUuidFrom(await (await upload(admin, await makeMapPng(280, 210, 70))).text());
    const saved = await act(admin, staged, '', { name: 'Kept As Uploaded' });

    expect(saved.status).toBe(302);
    expect(pendingRow(staged)).toBeNull();
  });

  test('discarding takes the candidates with it', async () => {
    offered = [candidate(), candidate({ imageUrl: 'https://other.example.org/x.png' })];

    const staged = stagedUuidFrom(await (await upload(admin, await makeMapPng(280, 210, 70))).text());
    expect(candidateCount(staged)).toBe(2);

    const discarded = await act(admin, staged, 'discard');
    expect(discarded.status).toBe(302);

    // The cascade is the whole cleanup story for candidate rows, so it is worth
    // asserting rather than assuming.
    expect(pendingRow(staged)).toBeNull();
    expect(candidateCount(staged)).toBe(0);
  });
});

describe('the candidate preview', () => {
  let staged: string;
  let candidateId: string;

  beforeAll(async () => {
    offered = [candidate({ thumb: new Uint8Array(await makeMapPng(60, 45, 15)), thumbFormat: 'png' })];
    const html = await (await upload(admin, await makeMapPng(280, 210, 70))).text();
    staged = stagedUuidFrom(html);
    candidateId = candidateIdFrom(html);
    offered = [];
  });

  test('is served to the admin who staged the upload', async () => {
    const response = await admin.get(`/i/pending/${staged}/candidate/${candidateId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });

  test('is not served to another admin', async () => {
    expect((await otherAdmin.get(`/i/pending/${staged}/candidate/${candidateId}`)).status).toBe(404);
  });

  test('is not served to a viewer', async () => {
    expect((await viewer.get(`/i/pending/${staged}/candidate/${candidateId}`)).status).toBe(403);
  });

  test('is not served to a stranger', async () => {
    expect((await new Client().get(`/i/pending/${staged}/candidate/${candidateId}`)).status).toBe(302);
  });
});

describe('adopting a copy', () => {
  /** Stages an upload that has one copy on offer, and returns both ids. */
  const stageWithOffer = async (image: Buffer, over: Partial<UploadCandidateInput> = {}) => {
    offered = [candidate(over)];
    const html = await (await upload(admin, image)).text();
    offered = [];
    return { staged: stagedUuidFrom(html), id: candidateIdFrom(html) };
  };

  test('replaces the image in place and keeps the upload staged', async () => {
    // One seed, two sizes: the same map painted larger, which is what a genuine
    // candidate is and what the fingerprint check exists to insist on.
    const seed = 5150;
    const { staged, id } = await stageWithOffer(await makeMapPng(280, 210, 70, seed));
    const before = pendingRow(staged)!;

    const bigger = await makeMapPng(1120, 840, 280, seed);
    download = async () => new Uint8Array(bigger);

    const response = await act(admin, staged, `adopt:${id}`, { name: 'Upgraded Keep' });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain('The image was replaced with a 1120×840 copy');
    expect(stagedUuidFrom(html)).toBe(staged);

    const after = pendingRow(staged)!;
    expect(after.image_width).toBe(1120);
    expect(after.image_height).toBe(840);
    expect(before.image_width).toBe(280);
  });

  test('refuses a copy that turns out to be a different map', async () => {
    const { staged, id } = await stageWithOffer(await makeMapPng(280, 210, 70));
    const before = pendingRow(staged)!;

    download = async () => new Uint8Array(await makeMapPng(1120, 840, 280, 987_654));

    const response = await act(admin, staged, `adopt:${id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('turned out to be a different image');

    const after = pendingRow(staged)!;
    expect(after.image_width).toBe(before.image_width);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  test('refuses a copy that is not actually larger once decoded', async () => {
    const original = await makeMapPng(280, 210, 70, 4242);
    const { staged, id } = await stageWithOffer(original);

    // The provider claimed 1120×840; the file behind it is the same size as ours.
    download = async () => new Uint8Array(original);

    const response = await act(admin, staged, `adopt:${id}`);
    expect(await response.text()).toContain('no larger than what you uploaded');
    expect(pendingRow(staged)!.image_width).toBe(280);
  });

  test('reports a refused download without losing the upload', async () => {
    const { staged, id } = await stageWithOffer(await makeMapPng(280, 210, 70));

    const { badRequest } = await import('../src/errors.ts');
    download = async () => {
      throw badRequest('That copy could not be downloaded (the site answered 403).');
    };

    const response = await act(admin, staged, `adopt:${id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('answered 403');
    expect(pendingRow(staged)).not.toBeNull();
  });

  test('cannot be done to someone else’s staged upload', async () => {
    const { staged, id } = await stageWithOffer(await makeMapPng(280, 210, 70));

    const response = await act(otherAdmin, staged, `adopt:${id}`);
    expect(response.status).toBe(404);
  });

  test('rejects a candidate id that belongs to another upload', async () => {
    const first = await stageWithOffer(await makeMapPng(280, 210, 70));
    const second = await stageWithOffer(await makeMapPng(280, 210, 70));

    const response = await act(admin, second.staged, `adopt:${first.id}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('no longer on offer');
  });
});

describe('the staged image share link', () => {
  test('serves the image to a stranger holding a valid token, and to nobody else', async () => {
    offered = [candidate()];
    const staged = stagedUuidFrom(await (await upload(admin, await makeMapPng(280, 210, 70))).text());
    offered = [];

    const { clearShareToken, mintShareToken } = await import('../src/models/pendingUploads.ts');
    const token = mintShareToken(staged, 300);

    // A provider has no session and never will, which is the whole reason this
    // route exists.
    const stranger = new Client();
    const served = await stranger.get(`/staged-image?t=${token}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toBe('no-store');

    expect((await stranger.get('/staged-image?t=not-a-real-token')).status).toBe(404);
    expect((await stranger.get('/staged-image')).status).toBe(404);

    // Revoked the moment the search that needed it comes back.
    clearShareToken(staged);
    expect((await stranger.get(`/staged-image?t=${token}`)).status).toBe(404);
  });

  test('stops working once the token has expired', async () => {
    offered = [candidate()];
    const staged = stagedUuidFrom(await (await upload(admin, await makeMapPng(280, 210, 70))).text());
    offered = [];

    const { expireShareTokens, mintShareToken } = await import('../src/models/pendingUploads.ts');
    const token = mintShareToken(staged, -1);

    expect((await new Client().get(`/staged-image?t=${token}`)).status).toBe(404);
    expect(expireShareTokens()).toBeGreaterThan(0);
  });

  test('is reachable while signed out, unlike every other image route', async () => {
    // The public-path list is the only thing making this true, so a change to it
    // should break a test rather than quietly close or open the route.
    const response = await app.request('/staged-image?t=nope', { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(404);
  });
});

describe('the search toggle', () => {
  test('is not offered when no provider is configured', async () => {
    // A toggle for a feature that cannot run implies the search is happening.
    const html = await (await admin.get('/maps/new')).text();

    expect(html).toContain('name="image"');
    expect(html).not.toContain('name="searchWeb"');
  });
});

describe('a search that goes wrong', () => {
  test('costs the upload nothing', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const { log } = await import('../src/log.ts');

    // The real orchestrator this time, not the stub — the containment is the
    // thing under test, and it lives inside the module the rest of this file
    // replaces.
    const enabled = loadConfig({
      WEB_SEARCH_PROVIDER: 'serpapi',
      SERPAPI_KEY: 'k',
      PUBLIC_BASE_URL: 'https://maps.example.test',
    }).webSearch;

    offered = [candidate()];
    const staged = stagedUuidFrom(await (await upload(admin, await makeMapPng(280, 210, 70))).text());
    offered = [];

    const pending = db.query('SELECT * FROM pending_uploads WHERE uuid = ?').get(staged) as PendingUpload;

    // The provider throws. Nothing about that is the admin's problem: it comes
    // back as "no candidates found" and the upload carries on.
    providerFails = true;

    const found = await realFindHigherResolution(
      { ...pending, uuid: staged, imageWidth: 280, imageHeight: 210 },
      { wanted: true, logger: log },
      { ...enabled, timeoutMs: 800 },
    );

    expect(found).toBe(0);

    // And the token it minted on the way in is gone again, not left live for the
    // staged upload's whole hour.
    const row = db.query('SELECT share_token FROM pending_uploads WHERE uuid = ?').get(staged) as {
      share_token: string | null;
    };
    expect(row.share_token).toBeNull();
  });
});
