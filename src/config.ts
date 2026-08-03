/**
 * Application configuration.
 *
 * Every setting comes from the environment (Bun loads `.env` automatically).
 * The whole environment is validated once at import time and the process
 * refuses to start on a bad value — a misconfigured server should fail loudly
 * at boot rather than surprise a user mid-request.
 */
import { isAbsolute, resolve } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The formats a map can be stored in.
 *
 * The same three the uploader accepts, because a stored map is re-encoded from
 * whatever was uploaded and has to be readable by the same decoder afterwards.
 */
export const IMAGE_FORMATS = ['webp', 'png', 'jpeg'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/**
 * Where to look for a higher-resolution copy of an upload.
 *
 * `none` is the default and disables the feature outright: no key is needed, no
 * image is ever exposed, and the upload path short-circuits before any network
 * call. Adding a provider here means adding a module under `src/websearch/`.
 */
export const WEB_SEARCH_PROVIDERS = ['none', 'serpapi'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface Config {
  readonly env: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;

  readonly databasePath: string;
  readonly imageDir: string;

  readonly maxUploadBytes: number;
  /**
   * How long an upload pasted in as an address may take to download, start to
   * finish. Separate from the web search's own timeout: that one belongs to a
   * feature that is off by default, and it covers a provider's answer rather
   * than a whole image coming down someone's home connection.
   */
  readonly importTimeoutMs: number;
  readonly maxImagePixels: number;
  readonly thumbSize: number;
  readonly thumbQuality: number;
  readonly pageSize: number;

  /** How an uploaded map is re-encoded for storage. */
  readonly image: {
    readonly format: ImageFormat;
    /**
     * 1–100. Meaningful for JPEG always, for WEBP unless `lossless` is set, and
     * for PNG only below 100, where it turns on palette quantisation — the one
     * way PNG can trade quality for size.
     */
    readonly quality: number;
    /** WEBP only: PNG is lossless whatever this says, and JPEG can never be. */
    readonly lossless: boolean;
  };

  /** Reserved for the deferred grid detector; validated now so it needs no config work later. */
  readonly grid: {
    readonly maxUpscale: number;
    readonly minConfidence: number;
    readonly minPx: number;
    readonly maxPx: number;
    readonly analysisMaxDim: number;
  };

  readonly fingerprint: {
    readonly maxDistance: number;
  };

  /**
   * Looking for a better copy of an upload on the web.
   *
   * Off unless `provider` says otherwise, because it costs an API key, a network
   * round trip on every upload, and a brief public URL for the staged image.
   */
  readonly webSearch: {
    readonly provider: WebSearchProvider;
    readonly apiKey: string;
    /**
     * The origin the search provider will fetch the staged image from. HOST and
     * PORT describe the socket this process binds, which is the wrong answer
     * behind a reverse proxy, so this has to be stated separately.
     */
    readonly publicBaseUrl: string;
    readonly timeoutMs: number;
    readonly maxCandidates: number;
    /** How much bigger a copy must be to be worth offering, as a fraction. */
    readonly minPixelGain: number;
    readonly maxDownloadBytes: number;
    /** Above this many pixels, an upload is good enough that searching is waste. */
    readonly skipAbovePixels: number;
    /** Searches allowed per rolling month, to stay inside a plan's quota. */
    readonly monthlyLimit: number;
    /** How long the staged image stays fetchable. Minutes, not hours. */
    readonly shareTtlSeconds: number;
  };

  readonly pendingUploadTtlSeconds: number;

  readonly sessionTtlSeconds: number;
  readonly sessionIdleSeconds: number;
  readonly cookieSecure: boolean;
  readonly trustProxy: boolean;

  readonly minPasswordLength: number;
  readonly loginMaxAttempts: number;
  readonly loginWindowSeconds: number;

  readonly logLevel: LogLevel;
}

/** Collects every problem so a misconfigured deploy reports all of them at once. */
class EnvReader {
  readonly problems: string[] = [];

  constructor(private readonly env: Record<string, string | undefined>) {}

  private raw(key: string): string | undefined {
    const value = this.env[key];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  string(key: string, fallback: string): string {
    return this.raw(key) ?? fallback;
  }

  enum<const T extends readonly string[]>(key: string, allowed: T, fallback: T[number]): T[number] {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    if (!allowed.includes(value)) {
      this.problems.push(`${key} must be one of ${allowed.join(', ')} (got "${value}")`);
      return fallback;
    }
    return value;
  }

  number(key: string, fallback: number, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      this.problems.push(`${key} must be a number (got "${value}")`);
      return fallback;
    }
    if (opts.integer && !Number.isInteger(parsed)) {
      this.problems.push(`${key} must be a whole number (got "${value}")`);
      return fallback;
    }
    if (opts.min !== undefined && parsed < opts.min) {
      this.problems.push(`${key} must be at least ${opts.min} (got ${parsed})`);
      return fallback;
    }
    if (opts.max !== undefined && parsed > opts.max) {
      this.problems.push(`${key} must be at most ${opts.max} (got ${parsed})`);
      return fallback;
    }
    return parsed;
  }

  /** Accepts a plain byte count or a friendly suffix: `25MB`, `500kb`, `1 GB`. */
  bytes(key: string, fallback: number, opts: { min: number; max: number }): number {
    const value = this.raw(key);
    if (value === undefined) return fallback;
    const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value);
    if (!match?.[1]) {
      this.problems.push(`${key} must be a byte count, optionally suffixed with KB/MB/GB (got "${value}")`);
      return fallback;
    }
    const multipliers: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
    const parsed = Math.floor(Number(match[1]) * (multipliers[(match[2] ?? 'b').toLowerCase()] ?? 1));
    if (parsed < opts.min || parsed > opts.max) {
      this.problems.push(`${key} must be between ${opts.min} and ${opts.max} bytes (got ${parsed})`);
      return fallback;
    }
    return parsed;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.raw(key)?.toLowerCase();
    if (value === undefined) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    this.problems.push(`${key} must be true or false (got "${value}")`);
    return fallback;
  }

  /** `jpg` is what people type, so it is accepted as a spelling of `jpeg`. */
  imageFormat(key: string, fallback: ImageFormat): ImageFormat {
    const value = this.raw(key)?.toLowerCase();
    if (value === undefined) return fallback;
    const normalised = value === 'jpg' ? 'jpeg' : value;
    if (!IMAGE_FORMATS.includes(normalised as ImageFormat)) {
      this.problems.push(`${key} must be one of ${IMAGE_FORMATS.join(', ')} (got "${value}")`);
      return fallback;
    }
    return normalised as ImageFormat;
  }

  /** Resolves to an absolute path so behaviour never depends on the working directory. */
  path(key: string, fallback: string): string {
    const value = this.raw(key) ?? fallback;
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
  }
}

/**
 * Checks that a search provider would actually be able to reach us.
 *
 * The provider fetches the staged image itself, from the public internet, so
 * this has to be an address the public internet can resolve and connect to over
 * TLS. Every mistake below produces a provider that fails on every single
 * upload, and none of them are visible without reading the logs — hence the
 * refusal to start.
 */
function publicBaseUrlProblems(value: string, provider: WebSearchProvider): string[] {
  if (value === '') {
    return [`WEB_SEARCH_PROVIDER=${provider} needs PUBLIC_BASE_URL, the address it will fetch staged images from`];
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [`PUBLIC_BASE_URL must be an absolute URL such as https://maps.example.com (got "${value}")`];
  }

  const problems: string[] = [];
  if (url.protocol !== 'https:') {
    problems.push(`PUBLIC_BASE_URL must use https (got "${url.protocol.replace(':', '')}")`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    problems.push(`PUBLIC_BASE_URL must be a bare origin, with no path or query (got "${value}")`);
  }
  // Only literal addresses can be judged here; a hostname's resolution is not
  // this process's to know. Catching the obvious ones is still worth it, because
  // "it works on my machine" is exactly how this setting gets filled in.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const unreachable =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (unreachable) {
    problems.push(`PUBLIC_BASE_URL must be reachable from the internet, and "${url.hostname}" is not`);
  }

  return problems;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const read = new EnvReader(env);

  const config: Config = {
    env: read.enum('NODE_ENV', ['development', 'production', 'test'] as const, 'development'),
    host: read.string('HOST', '127.0.0.1'),
    port: read.number('PORT', 3000, { min: 1, max: 65535, integer: true }),

    databasePath: read.path('DATABASE_PATH', './data/bmc.sqlite'),
    imageDir: read.path('IMAGE_DIR', './data/images'),

    maxUploadBytes: read.bytes('MAX_UPLOAD_BYTES', 25 * 1024 * 1024, { min: 1024, max: 1024 ** 3 }),
    importTimeoutMs: read.number('IMPORT_TIMEOUT_MS', 15_000, { min: 500, max: 120_000, integer: true }),
    maxImagePixels: read.number('MAX_IMAGE_PIXELS', 100_000_000, { min: 1_000, integer: true }),
    thumbSize: read.number('THUMB_SIZE', 400, { min: 32, max: 2000, integer: true }),
    thumbQuality: read.number('THUMB_QUALITY', 90, { min: 1, max: 100, integer: true }),
    pageSize: read.number('PAGE_SIZE', 24, { min: 1, max: 200, integer: true }),

    image: {
      format: read.imageFormat('IMAGE_FORMAT', 'webp'),
      quality: read.number('IMAGE_QUALITY', 95, { min: 1, max: 100, integer: true }),
      lossless: read.boolean('IMAGE_LOSSLESS', false),
    },

    grid: {
      maxUpscale: read.number('GRID_MAX_UPSCALE', 2.0, { min: 1, max: 8 }),
      minConfidence: read.number('GRID_MIN_CONFIDENCE', 2.5, { min: 1 }),
      minPx: read.number('GRID_MIN_PX', 16, { min: 2, integer: true }),
      maxPx: read.number('GRID_MAX_PX', 512, { min: 4, integer: true }),
      analysisMaxDim: read.number('GRID_ANALYSIS_MAX_DIM', 2400, { min: 256, integer: true }),
    },

    fingerprint: {
      // Out of 64 bits. Around 10 is the usual dividing line for a DCT hash:
      // low enough that unrelated maps do not collide, high enough to survive a
      // re-encode, a rescale, or a lighting change between two renders.
      maxDistance: read.number('FINGERPRINT_MAX_DISTANCE', 10, { min: 0, max: 64, integer: true }),
    },

    webSearch: {
      provider: read.enum('WEB_SEARCH_PROVIDER', WEB_SEARCH_PROVIDERS, 'none'),
      apiKey: read.string('SERPAPI_KEY', ''),
      // Trailing slashes are stripped rather than rejected: it is the single most
      // likely way to write this, and every use appends a path.
      publicBaseUrl: read.string('PUBLIC_BASE_URL', '').replace(/\/+$/, ''),
      // Short by design. A provider that has not answered in this long has cost
      // the admin more than a better copy of the map is worth.
      timeoutMs: read.number('WEB_SEARCH_TIMEOUT_MS', 6000, { min: 500, max: 60_000, integer: true }),
      maxCandidates: read.number('WEB_SEARCH_MAX_CANDIDATES', 5, { min: 1, max: 20, integer: true }),
      minPixelGain: read.number('WEB_SEARCH_MIN_PIXEL_GAIN', 0.2, { min: 0, max: 100 }),
      maxDownloadBytes: read.bytes('WEB_SEARCH_MAX_DOWNLOAD_BYTES', 25 * 1024 * 1024, {
        min: 1024,
        max: 1024 ** 3,
      }),
      skipAbovePixels: read.number('WEB_SEARCH_SKIP_ABOVE_PIXELS', 20_000_000, { min: 1000, integer: true }),
      monthlyLimit: read.number('WEB_SEARCH_MONTHLY_LIMIT', 250, { min: 1, integer: true }),
      shareTtlSeconds: read.number('WEB_SEARCH_SHARE_TTL_SECONDS', 300, { min: 30, max: 3600, integer: true }),
    },

    // How long an upload held back for duplicate confirmation stays on disk
    // before the maintenance sweep reclaims it.
    pendingUploadTtlSeconds: read.number('PENDING_UPLOAD_TTL_SECONDS', 3600, { min: 60, integer: true }),

    sessionTtlSeconds: read.number('SESSION_TTL_SECONDS', 60 * 60 * 24 * 14, { min: 60, integer: true }),
    sessionIdleSeconds: read.number('SESSION_IDLE_SECONDS', 60 * 60 * 24 * 3, { min: 60, integer: true }),
    cookieSecure: read.boolean('COOKIE_SECURE', true),
    trustProxy: read.boolean('TRUST_PROXY', false),

    minPasswordLength: read.number('MIN_PASSWORD_LENGTH', 12, { min: 8, max: 200, integer: true }),
    loginMaxAttempts: read.number('LOGIN_MAX_ATTEMPTS', 10, { min: 1, integer: true }),
    loginWindowSeconds: read.number('LOGIN_WINDOW_SECONDS', 900, { min: 10, integer: true }),

    logLevel: read.enum('LOG_LEVEL', LOG_LEVELS, 'info'),
  };

  // Cross-field checks that only make sense once every value has been parsed.
  if (config.grid.minPx >= config.grid.maxPx) {
    read.problems.push('GRID_MIN_PX must be smaller than GRID_MAX_PX');
  }
  if (config.sessionIdleSeconds > config.sessionTtlSeconds) {
    read.problems.push('SESSION_IDLE_SECONDS must not exceed SESSION_TTL_SECONDS');
  }
  // Better to refuse at boot than to quietly store lossy files for someone who
  // asked for lossless ones.
  if (config.image.lossless && config.image.format === 'jpeg') {
    read.problems.push('IMAGE_LOSSLESS cannot be set with IMAGE_FORMAT=jpeg, because JPEG is always lossy');
  }
  // A search provider that cannot work is worse than none at all: it would spend
  // a request on every upload and fail silently. Both of its prerequisites are
  // checked here so the operator hears about it at boot rather than from a log.
  if (config.webSearch.provider !== 'none') {
    if (config.webSearch.apiKey === '') {
      read.problems.push(`WEB_SEARCH_PROVIDER=${config.webSearch.provider} needs SERPAPI_KEY to be set`);
    }
    read.problems.push(...publicBaseUrlProblems(config.webSearch.publicBaseUrl, config.webSearch.provider));
  }

  if (read.problems.length > 0) {
    throw new Error(
      `Configuration is invalid, so the server did not start:\n` +
        read.problems.map((p) => `  - ${p}`).join('\n') +
        `\nCheck your .env file against .env.example.`,
    );
  }

  return config;
}

export const config = loadConfig();
