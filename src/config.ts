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

export interface Config {
  readonly env: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;

  readonly databasePath: string;
  readonly imageDir: string;

  readonly maxUploadBytes: number;
  readonly maxImagePixels: number;
  readonly thumbSize: number;
  readonly thumbQuality: number;
  readonly pageSize: number;

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

  /** Resolves to an absolute path so behaviour never depends on the working directory. */
  path(key: string, fallback: string): string {
    const value = this.raw(key) ?? fallback;
    return isAbsolute(value) ? value : resolve(process.cwd(), value);
  }
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const read = new EnvReader(env);

  const config: Config = {
    env: read.enum('NODE_ENV', ['development', 'production', 'test'] as const, 'development'),
    host: read.string('HOST', '127.0.0.1'),
    port: read.number('PORT', 3000, { min: 1, max: 65535, integer: true }),

    databasePath: read.path('DATABASE_PATH', './data/battlemapper.sqlite'),
    imageDir: read.path('IMAGE_DIR', './data/images'),

    maxUploadBytes: read.bytes('MAX_UPLOAD_BYTES', 25 * 1024 * 1024, { min: 1024, max: 1024 ** 3 }),
    maxImagePixels: read.number('MAX_IMAGE_PIXELS', 100_000_000, { min: 1_000, integer: true }),
    thumbSize: read.number('THUMB_SIZE', 400, { min: 32, max: 2000, integer: true }),
    thumbQuality: read.number('THUMB_QUALITY', 90, { min: 1, max: 100, integer: true }),
    pageSize: read.number('PAGE_SIZE', 24, { min: 1, max: 200, integer: true }),

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
