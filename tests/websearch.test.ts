/**
 * The parts of the higher-resolution search that can be tested without a
 * network: which addresses may be fetched, what a provider's answer maps to, and
 * which of those answers are worth offering.
 *
 * The SSRF guard resolves DNS before it calls `fetch`, so stubbing `fetch` alone
 * proves nothing about it — the resolver is injected here for the same reason it
 * is injectable at all.
 */
import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../src/config.ts';
import { selectUpgrades } from '../src/websearch/filter.ts';
import { fetchRemoteImage, isPubliclyRoutable } from '../src/websearch/fetchImage.ts';
import { search } from '../src/websearch/serpapi.ts';
import type { SearchResult, WebSearchSettings } from '../src/websearch/types.ts';

const settings: WebSearchSettings = {
  ...loadConfig({}).webSearch,
  apiKey: 'test-key',
  publicBaseUrl: 'https://maps.example.test',
};

/** A resolver that answers with whatever the test says the name points at. */
const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address }));

const okResponse = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });

describe('address filtering', () => {
  test('accepts ordinary public addresses', () => {
    expect(isPubliclyRoutable('93.184.216.34')).toBe(true);
    expect(isPubliclyRoutable('8.8.8.8')).toBe(true);
    expect(isPubliclyRoutable('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });

  test.each([
    ['loopback', '127.0.0.1'],
    ['loopback, elsewhere in the range', '127.99.4.2'],
    ['private 10/8', '10.0.0.5'],
    ['private 172.16/12', '172.20.10.1'],
    ['private 192.168/16', '192.168.1.1'],
    ['link-local, and the cloud metadata service', '169.254.169.254'],
    ['unspecified', '0.0.0.0'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['multicast', '224.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unspecified', '::'],
    ['IPv6 unique local', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped private', '::ffff:10.1.2.3'],
    ['not an address at all', 'nonsense'],
  ])('refuses %s', (_label, address) => {
    expect(isPubliclyRoutable(address)).toBe(false);
  });
});

describe('fetching a candidate image', () => {
  const options = { maxBytes: 1024, timeoutMs: 1000 };

  test('refuses anything that is not https', async () => {
    expect(
      fetchRemoteImage('http://example.test/map.png', options, { lookup: resolvesTo('93.184.216.34') }),
    ).rejects.toThrow(/secure connection/);
  });

  test('refuses a host that resolves inside the network', async () => {
    expect(
      fetchRemoteImage('https://internal.example.test/map.png', options, { lookup: resolvesTo('10.0.0.7') }),
    ).rejects.toThrow(/will not fetch from/);
  });

  test('refuses a host with even one private answer', async () => {
    // A name that resolves to both is the interesting case: taking the public
    // answer and connecting anyway is exactly the mistake worth not making.
    expect(
      fetchRemoteImage('https://mixed.example.test/map.png', options, {
        lookup: resolvesTo('93.184.216.34', '127.0.0.1'),
      }),
    ).rejects.toThrow(/will not fetch from/);
  });

  test('follows a redirect and returns the body', async () => {
    const fetch = async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/real.png' } })
        : okResponse('image-bytes');
    };

    const bytes = await fetchRemoteImage('https://example.test/start', options, {
      lookup: resolvesTo('93.184.216.34'),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(new TextDecoder().decode(bytes)).toBe('image-bytes');
  });

  test('re-checks each redirect, so a public host cannot point inward', async () => {
    const fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://inside.example.test/secret' } });

    const lookup = async (hostname: string) =>
      hostname === 'inside.example.test' ? [{ address: '169.254.169.254' }] : [{ address: '93.184.216.34' }];

    expect(
      fetchRemoteImage('https://example.test/start', options, { lookup, fetch: fetch as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow(/will not fetch from/);
  });

  test('gives up on a redirect loop', async () => {
    const fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.test/again' } });

    expect(
      fetchRemoteImage('https://example.test/start', options, {
        lookup: resolvesTo('93.184.216.34'),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/redirects too many times/);
  });

  test('refuses a body that declares itself too large', async () => {
    const fetch = async () => okResponse('x'.repeat(10), { 'content-length': '99999' });

    expect(
      fetchRemoteImage('https://example.test/map.png', options, {
        lookup: resolvesTo('93.184.216.34'),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/larger than this server will download/);
  });

  test('stops reading a body that lied about its length', async () => {
    // No content-length at all, and far more bytes than allowed: the running
    // total is what has to catch this, not the header.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 40; i++) controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    const fetch = async () => new Response(body, { status: 200 });

    expect(
      fetchRemoteImage('https://example.test/map.png', options, {
        lookup: resolvesTo('93.184.216.34'),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/larger than this server will download/);
  });

  test('reports a refusal by the host as an ordinary failure', async () => {
    const fetch = async () => new Response(null, { status: 403 });

    expect(
      fetchRemoteImage('https://example.test/map.png', options, {
        lookup: resolvesTo('93.184.216.34'),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/answered 403/);
  });

  test('names what it is fetching however the caller asks', async () => {
    expect(
      fetchRemoteImage('https://internal.example.test/map.png', { ...options, subject: 'That image' }, {
        lookup: resolvesTo('10.0.0.7'),
      }),
    ).rejects.toThrow(/^That image is hosted somewhere/);
  });
});

/**
 * The relaxation the upload form's address field asks for, and everything it is
 * deliberately not.
 */
describe('fetching from an address an administrator typed', () => {
  const options = { maxBytes: 1024, timeoutMs: 1000, allowInsecure: true };

  test('allows plaintext, which the search path still refuses', async () => {
    const fetch = async () => okResponse('image-bytes');

    const bytes = await fetchRemoteImage('http://example.test/map.png', options, {
      lookup: resolvesTo('93.184.216.34'),
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(new TextDecoder().decode(bytes)).toBe('image-bytes');
  });

  test('still refuses a scheme that is neither http nor https', async () => {
    expect(fetchRemoteImage('file:///etc/passwd', options, { lookup: resolvesTo('93.184.216.34') })).rejects.toThrow(
      /neither http nor https/,
    );
  });

  test('still refuses a plaintext host inside the network', async () => {
    // The scheme is what was relaxed; the address check is what does the work,
    // and it does not care which one it was reached over.
    expect(
      fetchRemoteImage('http://internal.example.test/map.png', options, { lookup: resolvesTo('169.254.169.254') }),
    ).rejects.toThrow(/will not fetch from/);
  });

  test('still re-checks a plaintext redirect', async () => {
    const fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'http://inside.example.test/secret' } });
    const lookup = async (hostname: string) =>
      hostname === 'inside.example.test' ? [{ address: '10.0.0.7' }] : [{ address: '93.184.216.34' }];

    expect(
      fetchRemoteImage('http://example.test/start', options, {
        lookup,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/will not fetch from/);
  });
});

describe('reading a provider answer', () => {
  const lensResponse = (matches: unknown[]) =>
    okResponse(JSON.stringify({ visual_matches: matches }), { 'content-type': 'application/json' });

  const stubFetch = (response: Response) => (async () => response) as unknown as typeof globalThis.fetch;

  test('maps a visual match to a candidate', async () => {
    const results = await search('https://maps.example.test/staged-image?t=x', settings, {
      fetch: stubFetch(
        lensResponse([
          {
            title: 'Sunken Chapel',
            link: 'https://maps.example.org/sunken-chapel',
            source: 'maps.example.org',
            thumbnail: 'https://maps.example.org/thumb.jpg',
            image: 'https://maps.example.org/full.png',
            image_width: 4000,
            image_height: 3000,
            exact_matches: 7,
          },
        ]),
      ),
    });

    expect(results).toEqual([
      {
        imageUrl: 'https://maps.example.org/full.png',
        pageUrl: 'https://maps.example.org/sunken-chapel',
        source: 'maps.example.org',
        title: 'Sunken Chapel',
        width: 4000,
        height: 3000,
        thumbnailUrl: 'https://maps.example.org/thumb.jpg',
        exact: 7,
      },
    ]);
  });

  test('drops matches with no image or no dimensions', async () => {
    const results = await search('https://maps.example.test/staged-image?t=x', settings, {
      fetch: stubFetch(
        lensResponse([
          { image: 'https://a.example.org/x.png' }, // no dimensions
          { image_width: 400, image_height: 300 }, // no image
          { image: 'https://b.example.org/y.png', image_width: 400, image_height: 0 },
          { image: 'https://c.example.org/z.png', image_width: 400, image_height: 300 },
        ]),
      ),
    });

    expect(results.map((result) => result.imageUrl)).toEqual(['https://c.example.org/z.png']);
  });

  test('treats an error reported in a 200 as a failure', async () => {
    expect(
      search('https://maps.example.test/staged-image?t=x', settings, {
        fetch: stubFetch(
          okResponse(JSON.stringify({ error: 'Invalid API key' }), { 'content-type': 'application/json' }),
        ),
      }),
    ).rejects.toThrow(/returned no answer/);
  });

  test('treats a non-200 as a failure', async () => {
    expect(
      search('https://maps.example.test/staged-image?t=x', settings, {
        fetch: stubFetch(new Response(null, { status: 401 })),
      }),
    ).rejects.toThrow(/could not be reached/);
  });

  test('never puts the API key where an error could carry it', async () => {
    try {
      await search('https://maps.example.test/staged-image?t=x', settings, {
        fetch: stubFetch(new Response(null, { status: 500 })),
      });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('test-key');
    }
  });
});

describe('choosing which copies to offer', () => {
  const staged = { imageWidth: 1000, imageHeight: 800 };

  const result = (over: Partial<SearchResult>): SearchResult => ({
    imageUrl: 'https://example.org/a.png',
    pageUrl: null,
    source: null,
    title: null,
    width: 2000,
    height: 1600,
    thumbnailUrl: null,
    exact: 0,
    ...over,
  });

  test('keeps only copies with meaningfully more pixels', () => {
    const kept = selectUpgrades(
      [
        result({ imageUrl: 'smaller', width: 500, height: 400 }),
        result({ imageUrl: 'same', width: 1000, height: 800 }),
        result({ imageUrl: 'barely', width: 1050, height: 840 }),
        result({ imageUrl: 'bigger', width: 2000, height: 1600 }),
      ],
      staged,
      settings,
    );

    expect(kept.map((entry) => entry.imageUrl)).toEqual(['bigger']);
  });

  test('drops a copy of a different shape', () => {
    // A crop or a padded version would fail to fit the admin's square counts,
    // on fields the review page does not let them correct.
    const kept = selectUpgrades(
      [
        result({ imageUrl: 'cropped', width: 2000, height: 1200 }),
        result({ imageUrl: 'same shape', width: 2000, height: 1600 }),
      ],
      staged,
      settings,
    );

    expect(kept.map((entry) => entry.imageUrl)).toEqual(['same shape']);
  });

  test('ranks by how widely republished a copy is, then by size', () => {
    const kept = selectUpgrades(
      [
        result({ imageUrl: 'huge but obscure', width: 4000, height: 3200, exact: 0 }),
        result({ imageUrl: 'well known', width: 2000, height: 1600, exact: 12 }),
        result({ imageUrl: 'well known and larger', width: 3000, height: 2400, exact: 12 }),
      ],
      staged,
      settings,
    );

    expect(kept.map((entry) => entry.imageUrl)).toEqual([
      'well known and larger',
      'well known',
      'huge but obscure',
    ]);
  });

  test('offers no more than the configured number', () => {
    const many = Array.from({ length: 9 }, (_, n) => result({ imageUrl: `copy-${n}`, exact: n }));

    expect(selectUpgrades(many, staged, { ...settings, maxCandidates: 3 })).toHaveLength(3);
  });
});
