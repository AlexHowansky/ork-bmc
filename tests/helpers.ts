/** Shared test utilities: a cookie-aware client and image fixtures. */
import sharp from 'sharp';

import { app } from '../src/server.tsx';
import { migrate } from '../src/db/migrate.ts';
import { createUser, type Role } from '../src/models/users.ts';

let migrated = false;

export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await migrate();
  migrated = true;
}

const ORIGIN = 'http://localhost';

/**
 * A minimal cookie jar over `app.request()`.
 *
 * Real browser semantics are not needed — the tests only require that cookies
 * set by one response are sent on the next, which is what makes session and
 * CSRF flows testable without starting a server.
 */
export class Client {
  private cookies = new Map<string, string>();

  private header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  }

  /**
   * Plants a cookie directly, for tests that need to present one the app would
   * never write — a tampered search memory, say.
   */
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const index = pair?.indexOf('=') ?? -1;
      if (index <= 0) continue;

      const name = pair!.slice(0, index);
      const value = pair!.slice(index + 1);
      // An expiry in the past is a deletion.
      if (value === '' || /Max-Age=0/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async get(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await app.request(path, {
      ...init,
      headers: { Accept: 'text/html', ...this.header(), ...(init.headers as Record<string, string>) },
    });
    this.absorb(response);
    return response;
  }

  /** POSTs a form, supplying the Origin header the origin-CSRF layer expects. */
  async post(path: string, body: FormData | URLSearchParams, init: RequestInit = {}): Promise<Response> {
    const response = await app.request(path, {
      method: 'POST',
      body,
      ...init,
      headers: {
        Accept: 'text/html',
        Origin: ORIGIN,
        ...this.header(),
        ...(init.headers as Record<string, string>),
      },
    });
    this.absorb(response);
    return response;
  }

  /**
   * Reads the CSRF token out of a rendered page.
   *
   * Follows one redirect, as a browser would: `/maps` bounces to the remembered
   * search once one has been run, and a token has to come from the page that is
   * actually rendered. `get` itself stays literal, because most of the suite is
   * asserting on the redirects themselves.
   */
  async csrfToken(path = '/maps'): Promise<string> {
    let response = await this.get(path);

    const location = response.status === 302 ? response.headers.get('location') : null;
    if (location) response = await this.get(location);

    const html = await response.text();
    return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  }

  async login(email: string, password: string): Promise<Response> {
    const token = await this.csrfToken('/login');
    return this.post(
      '/login',
      new URLSearchParams({ _csrf: token, email, password }),
    );
  }
}

let userSeq = 0;

/** Creates an account with a unique email so tests never collide. */
export async function makeUser(role: Role): Promise<{ email: string; password: string }> {
  await ensureSchema();
  const email = `${role}-${++userSeq}-${Date.now()}@example.test`;
  const password = 'a sufficiently long passphrase';
  await createUser({ email, password, role });
  return { email, password };
}

export async function signedInAs(role: Role): Promise<Client> {
  const { email, password } = await makeUser(role);
  const client = new Client();
  await client.login(email, password);
  return client;
}

let imageSeed = 0;

/**
 * Generates a PNG with a painted grid, as a battle map would have.
 *
 * Every call paints a different map. That matters because uploads are now
 * checked for near-duplicates: a fixture that looked the same every time would
 * make the second upload in any test hit the duplicate warning instead of
 * redirecting. Pass an explicit `seed` to ask for the same image twice, which is
 * how a test says "upload a duplicate".
 *
 * The seed drives large blocks of light and dark rather than a colour tweak,
 * because the fingerprint is taken from a greyscale 32×32 reduction — only
 * low-frequency structure moves it.
 */
export async function makeMapPng(width = 280, height = 210, grid = 70, seed = ++imageSeed): Promise<Buffer> {
  const rgb = Buffer.alloc(width * height * 3);

  // Four features whose positions and sizes are derived from the seed, so
  // consecutive seeds produce visibly different arrangements.
  const blobs = Array.from({ length: 4 }, (_, n) => {
    const salt = seed * 7919 + n * 104_729;
    return {
      cx: (salt % 97) / 97,
      cy: ((salt >> 3) % 89) / 89,
      radius: 0.12 + (((salt >> 6) % 23) / 23) * 0.18,
      dark: ((salt >> 9) & 1) === 1,
    };
  });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const onLine = x % grid === 0 || y % grid === 0;

      let shade = 0;
      for (const blob of blobs) {
        const dx = x / width - blob.cx;
        const dy = y / height - blob.cy;
        if (dx * dx + dy * dy < blob.radius * blob.radius) shade += blob.dark ? -45 : 45;
      }

      const clamp = (value: number) => Math.max(0, Math.min(255, value));
      rgb[i] = onLine ? 40 : clamp(110 + shade);
      rgb[i + 1] = onLine ? 34 : clamp(130 + shade);
      rgb[i + 2] = onLine ? 28 : clamp(80 + shade);
    }
  }

  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

let mapSeq = 0;

/** Builds the multipart body the upload form posts. */
export function uploadForm(
  token: string,
  image: Buffer,
  overrides: Partial<Record<'name' | 'variant' | 'tags' | 'gridSize' | 'gridWidth' | 'gridHeight', string>> = {},
  filename = 'map.png',
): FormData {
  const form = new FormData();
  form.set('_csrf', token);
  form.set('name', overrides.name ?? `Test Map ${++mapSeq}-${Date.now()}`);
  form.set('variant', overrides.variant ?? '');
  form.set('tags', overrides.tags ?? '');
  form.set('gridSize', overrides.gridSize ?? '');
  form.set('gridWidth', overrides.gridWidth ?? '');
  form.set('gridHeight', overrides.gridHeight ?? '');
  form.set('image', new File([image as unknown as BlobPart], filename, { type: 'image/png' }));
  return form;
}

/** Pulls the new map's UUID out of the redirect a successful upload returns. */
export function uuidFromRedirect(response: Response): string {
  return response.headers.get('location')?.replace('/maps/', '') ?? '';
}
