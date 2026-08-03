/**
 * Fetching an image from an address this app did not choose.
 *
 * Every other outbound path in this app has no user input in it at all. This one
 * is handed a URL — by a third-party search API, or by an administrator pasting
 * one into the upload form — and asked to download whatever is there, which makes
 * it the app's only server-side request forgery surface. The rules below are what
 * keep it from being a proxy into the network this process happens to be sitting
 * in:
 *
 *   - the scheme is an allowlist, so `file:`, `data:` and the rest are refused
 *     however a redirect chain arrives at them. It holds https only unless the
 *     caller passes `allowInsecure`, which exists for the one caller whose URL
 *     was typed by an administrator rather than supplied by a third party: a map
 *     is still published over plaintext often enough that refusing would just
 *     mean fetching it by hand. What that costs is tamper-evidence in transit,
 *     which is not what stands between this and the local network — the address
 *     check below is, and it does not care about the scheme;
 *   - the hostname is resolved first and every address it answers with must be
 *     publicly routable, which is what stops `internal.example.com` resolving to
 *     10.0.0.5 and stops the AWS metadata service at 169.254.169.254;
 *   - redirects are followed by hand so each hop is checked the same way, rather
 *     than letting a public host bounce us somewhere private;
 *   - a byte ceiling is applied to the declared length *and* to what actually
 *     arrives, because `Content-Length` is a claim, not a fact;
 *   - a deadline covers the whole exchange, so a server that dribbles bytes
 *     forever cannot pin a request handler open.
 *
 * What it deliberately does not solve: DNS rebinding. The name is resolved here
 * and resolved again by the connect inside `fetch`, and nothing Bun exposes lets
 * those be made the same lookup — pinning the address by connecting to the IP
 * directly would break TLS certificate verification, which is a worse trade. An
 * attacker would need to control a DNS name, return a public address to this
 * check and a private one microseconds later, and then get something back that
 * survives `sniffFormat` and sharp. That is a narrow enough gap to accept and
 * write down rather than to paper over.
 *
 * Nothing here validates that the bytes are an image. `sniffFormat` in
 * `src/images/process.ts` owns that, from the leading bytes, and ignores
 * whatever `Content-Type` claims.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { badRequest } from '../errors.ts';

/** Seams for tests: DNS happens before `fetch`, so stubbing `fetch` proves nothing. */
export interface FetchDeps {
  lookup?: (hostname: string) => Promise<{ address: string }[]>;
  fetch?: typeof globalThis.fetch;
}

export interface FetchImageOptions {
  maxBytes: number;
  timeoutMs: number;
  /** How many redirects to follow. Each one is re-validated from scratch. */
  maxRedirects?: number;
  /** Permit `http:` as well. Only for an address an administrator typed by hand. */
  allowInsecure?: boolean;
  /**
   * How the messages below name what is being fetched. The default suits the
   * search results this was written for; an import says "That image", because
   * "that copy" means nothing when there is no original to be a copy of.
   */
  subject?: string;
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_SUBJECT = 'That copy';

const defaultLookup = (hostname: string): Promise<{ address: string }[]> => dnsLookup(hostname, { all: true });

/**
 * Is this address one the public internet could have routed us to?
 *
 * Written as a deny list of the ranges that mean "somewhere inside", which is
 * the shape the risk actually has: the danger is not an unusual address, it is a
 * reachable neighbour. Anything unparseable is refused too, on the grounds that
 * a resolver answering with something this cannot read is not an address worth
 * trusting.
 */
export function isPubliclyRoutable(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicV4(address);
  if (version === 6) return isPublicV6(address);
  return false;
}

function isPublicV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, and the cloud metadata services
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0) return false; // IETF protocol assignments, incl. 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a >= 224) return false; // multicast, reserved, broadcast

  return true;
}

function isPublicV6(address: string): boolean {
  const normalised = address.toLowerCase().split('%')[0] ?? '';

  // An IPv4 address wearing an IPv6 hat routes to the IPv4 address, so it has to
  // be judged as one — ::ffff:127.0.0.1 is loopback however it is spelled.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped?.[1]) return isPublicV4(mapped[1]);

  if (normalised === '::' || normalised === '::1') return false; // unspecified, loopback
  if (/^f[cd]/.test(normalised)) return false; // unique local
  if (/^fe[89ab]/.test(normalised)) return false; // link-local
  if (/^ff/.test(normalised)) return false; // multicast
  if (/^(2001:0?db8|64:ff9b|100:)/.test(normalised)) return false; // documentation, translation, discard

  return true;
}

/** Rejects a URL this app must not dereference, and returns it parsed if it may. */
async function assertFetchable(rawUrl: string, options: FetchImageOptions, deps: FetchDeps): Promise<URL> {
  const subject = options.subject ?? DEFAULT_SUBJECT;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest(`${subject} is at an address that could not be understood.`);
  }

  if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) {
    throw badRequest(
      options.allowInsecure
        ? `${subject} is at an address that is neither http nor https, so it was not downloaded.`
        : `${subject} is not served over a secure connection, so it was not downloaded.`,
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, subject, deps);

  if (addresses.length === 0 || !addresses.every((entry) => isPubliclyRoutable(entry.address))) {
    throw badRequest(`${subject} is hosted somewhere this server will not fetch from.`);
  }

  return url;
}

async function resolve(hostname: string, subject: string, deps: FetchDeps): Promise<{ address: string }[]> {
  try {
    return await (deps.lookup ?? defaultLookup)(hostname);
  } catch {
    throw badRequest(`${subject} is at an address that could not be found.`);
  }
}

/**
 * Downloads an image from an untrusted URL, or throws an `AppError` saying why not.
 *
 * A failure here is ordinary rather than exceptional: hotlink protection, expired
 * CDN links and geoblocking make a refused download the common case, so every
 * rejection carries a message that reads sensibly on the review page.
 */
export async function fetchRemoteImage(
  rawUrl: string,
  options: FetchImageOptions,
  deps: FetchDeps = {},
): Promise<Uint8Array> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const subject = options.subject ?? DEFAULT_SUBJECT;
  // One deadline for the whole exchange, redirects included, so a chain of slow
  // hops cannot add up to an unbounded wait.
  const signal = AbortSignal.timeout(options.timeoutMs);

  let target = await assertFetchable(rawUrl, options, deps);

  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(target, { redirect: 'manual', signal });
    } catch (error) {
      throw badRequest(
        signal.aborted
          ? `${subject} took too long to download.`
          : `${subject} could not be downloaded from where it is hosted.`,
        { cause: error },
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw badRequest(`${subject} could not be downloaded from where it is hosted.`);
      if (hop >= maxRedirects) throw badRequest(`${subject} redirects too many times to follow.`);

      // Re-validated from scratch, not merely resolved: the whole point of
      // following redirects by hand is that a public host may point inward.
      target = await assertFetchable(new URL(location, target).toString(), options, deps);
      continue;
    }

    if (!response.ok) {
      throw badRequest(`${subject} could not be downloaded (the site answered ${response.status}).`);
    }

    return await readCapped(response, options.maxBytes, subject);
  }
}

/**
 * Reads a body, refusing to hold more than `maxBytes` of it.
 *
 * The declared length is checked first because it is free, and then ignored:
 * a response can under-declare, or omit the header entirely and stream forever.
 * The running total is what actually bounds the memory.
 */
async function readCapped(response: Response, maxBytes: number, subject: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw badRequest(`${subject} is larger than this server will download.`);
  }

  const body = response.body;
  if (!body) throw badRequest(`${subject} could not be downloaded from where it is hosted.`);

  const chunks: Uint8Array[] = [];
  let total = 0;

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw badRequest(`${subject} is larger than this server will download.`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}
