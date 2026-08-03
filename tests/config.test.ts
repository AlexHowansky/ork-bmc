/**
 * Configuration parsing.
 *
 * `loadConfig` takes the environment as an argument precisely so this can be
 * exercised without touching the process's own.
 */
import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../src/config.ts';

/** Only the keys under test; everything else falls back to its default. */
const load = (env: Record<string, string>) => loadConfig(env);

describe('image storage settings', () => {
  test('default to WEBP, not lossless', () => {
    expect(load({}).image).toEqual({ format: 'webp', quality: 95, lossless: false });
  });

  test('accept each supported format, and "jpg" as a spelling of "jpeg"', () => {
    expect(load({ IMAGE_FORMAT: 'png' }).image.format).toBe('png');
    expect(load({ IMAGE_FORMAT: 'JPEG' }).image.format).toBe('jpeg');
    expect(load({ IMAGE_FORMAT: 'jpg' }).image.format).toBe('jpeg');
    expect(load({ IMAGE_FORMAT: ' WebP ' }).image.format).toBe('webp');
  });

  test('refuse a format nothing can read', () => {
    expect(() => load({ IMAGE_FORMAT: 'gif' })).toThrow(/IMAGE_FORMAT must be one of/);
    expect(() => load({ IMAGE_FORMAT: 'tiff' })).toThrow(/IMAGE_FORMAT/);
  });

  test('read quality and the lossless flag', () => {
    expect(load({ IMAGE_QUALITY: '82' }).image.quality).toBe(82);
    expect(load({ IMAGE_LOSSLESS: 'true' }).image.lossless).toBe(true);
    expect(load({ IMAGE_LOSSLESS: 'no' }).image.lossless).toBe(false);
  });

  test('refuse a quality outside 1–100', () => {
    expect(() => load({ IMAGE_QUALITY: '0' })).toThrow(/IMAGE_QUALITY must be at least 1/);
    expect(() => load({ IMAGE_QUALITY: '101' })).toThrow(/IMAGE_QUALITY must be at most 100/);
    expect(() => load({ IMAGE_QUALITY: 'best' })).toThrow(/IMAGE_QUALITY must be a number/);
  });

  test('refuse lossless JPEG rather than quietly storing a lossy file', () => {
    expect(() => load({ IMAGE_FORMAT: 'jpeg', IMAGE_LOSSLESS: 'true' })).toThrow(/JPEG is always lossy/);
    // The same flag is fine for the formats that can honour it.
    expect(load({ IMAGE_FORMAT: 'webp', IMAGE_LOSSLESS: 'true' }).image.lossless).toBe(true);
    expect(load({ IMAGE_FORMAT: 'png', IMAGE_LOSSLESS: 'true' }).image.lossless).toBe(true);
  });

  test('report every problem at once, so one boot fixes them all', () => {
    try {
      load({ IMAGE_FORMAT: 'gif', IMAGE_QUALITY: '900' });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('IMAGE_FORMAT');
      expect(message).toContain('IMAGE_QUALITY');
    }
  });
});

describe('the import download timeout', () => {
  test('defaults to something a real image can arrive within', () => {
    expect(load({}).importTimeoutMs).toBe(15_000);
  });

  test('is its own setting, not the search provider timeout', () => {
    const config = load({ IMPORT_TIMEOUT_MS: '30000' });

    expect(config.importTimeoutMs).toBe(30_000);
    expect(config.webSearch.timeoutMs).toBe(6000);
  });

  test('refuses a value outside its bounds', () => {
    expect(() => load({ IMPORT_TIMEOUT_MS: '100' })).toThrow(/IMPORT_TIMEOUT_MS must be at least 500/);
    expect(() => load({ IMPORT_TIMEOUT_MS: '600000' })).toThrow(/IMPORT_TIMEOUT_MS must be at most 120000/);
    expect(() => load({ IMPORT_TIMEOUT_MS: 'soon' })).toThrow(/IMPORT_TIMEOUT_MS must be a number/);
  });
});

describe('higher-resolution search settings', () => {
  const enabled = { WEB_SEARCH_PROVIDER: 'serpapi', SERPAPI_KEY: 'k', PUBLIC_BASE_URL: 'https://maps.example.com' };

  test('are off by default, and need nothing else to be', () => {
    expect(load({}).webSearch.provider).toBe('none');
    expect(load({}).webSearch.apiKey).toBe('');
    expect(load({}).webSearch.publicBaseUrl).toBe('');
  });

  test('accept a full configuration', () => {
    expect(load(enabled).webSearch.provider).toBe('serpapi');
  });

  test('reject an unknown provider', () => {
    expect(() => load({ ...enabled, WEB_SEARCH_PROVIDER: 'tineye' })).toThrow(/WEB_SEARCH_PROVIDER must be one of/);
  });

  test('refuse to start a provider with no key', () => {
    expect(() => load({ ...enabled, SERPAPI_KEY: '' })).toThrow(/needs SERPAPI_KEY/);
  });

  test('refuse to start a provider with no address to fetch from', () => {
    expect(() => load({ ...enabled, PUBLIC_BASE_URL: '' })).toThrow(/needs PUBLIC_BASE_URL/);
  });

  test('insist the address is one the internet could reach', () => {
    // Each of these would fail on every single upload, silently, and the logs
    // would be the only place that said so.
    expect(() => load({ ...enabled, PUBLIC_BASE_URL: 'http://maps.example.com' })).toThrow(/must use https/);
    expect(() => load({ ...enabled, PUBLIC_BASE_URL: 'https://localhost:3000' })).toThrow(/reachable from the internet/);
    expect(() => load({ ...enabled, PUBLIC_BASE_URL: 'https://192.168.1.10' })).toThrow(/reachable from the internet/);
    expect(() => load({ ...enabled, PUBLIC_BASE_URL: 'maps.example.com' })).toThrow(/must be an absolute URL/);
    expect(() => load({ ...enabled, PUBLIC_BASE_URL: 'https://maps.example.com/bmc' })).toThrow(/bare origin/);
  });

  test('forgive a trailing slash rather than refusing over one', () => {
    expect(load({ ...enabled, PUBLIC_BASE_URL: 'https://maps.example.com/' }).webSearch.publicBaseUrl).toBe(
      'https://maps.example.com',
    );
  });

  test('report a missing key and a bad address together', () => {
    try {
      load({ WEB_SEARCH_PROVIDER: 'serpapi', SERPAPI_KEY: '', PUBLIC_BASE_URL: 'http://localhost' });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('SERPAPI_KEY');
      expect(message).toContain('https');
      expect(message).toContain('reachable from the internet');
    }
  });
});
