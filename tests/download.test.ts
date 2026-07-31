/**
 * Download filenames.
 *
 * The property that matters is that no two maps in a library can produce the
 * same filename, because downloading several of them puts every file in one
 * folder.
 */
import { describe, expect, test } from 'bun:test';

import { downloadFilename } from '../src/routes/files.ts';

const uuid = '3f2a1b9c-4d5e-4f60-8a1b-2c3d4e5f6071';
const other = 'a1b2c3d4-4d5e-4f60-8a1b-2c3d4e5f6071';

describe('downloadFilename', () => {
  test('slugs the name and ends in .webp', () => {
    expect(downloadFilename({ name: 'River Crossing', variant: '', uuid })).toBe('river-crossing-3f2a1b9c.webp');
  });

  test('includes the variant, so a map’s variants do not overwrite each other', () => {
    const day = downloadFilename({ name: 'River Crossing', variant: 'day', uuid });
    const night = downloadFilename({ name: 'River Crossing', variant: 'night', uuid: other });

    expect(day).toContain('river-crossing-day');
    expect(night).toContain('river-crossing-night');
    expect(day).not.toBe(night);
  });

  test('separates two maps whose name and variant slug to the same thing', () => {
    // Both are legal rows: the unique index is on the pair, not on the slug.
    const withVariant = downloadFilename({ name: 'River Crossing', variant: 'day', uuid });
    const withoutVariant = downloadFilename({ name: 'River Crossing Day', variant: '', uuid: other });

    expect(withVariant).not.toBe(withoutVariant);
  });

  test('separates names differing only in punctuation', () => {
    expect(downloadFilename({ name: 'Bridge!', variant: '', uuid })).not.toBe(
      downloadFilename({ name: 'Bridge?', variant: '', uuid: other }),
    );
  });

  test('separates long names that share their first 80 characters', () => {
    const prefix = 'The Long Walk '.repeat(8);
    expect(downloadFilename({ name: `${prefix} north`, variant: '', uuid })).not.toBe(
      downloadFilename({ name: `${prefix} south`, variant: '', uuid: other }),
    );
  });

  test('separates names with nothing sluggable in them', () => {
    const first = downloadFilename({ name: '桜の城', variant: '', uuid });
    const second = downloadFilename({ name: '!!!', variant: '', uuid: other });

    expect(first).toBe('battle-map-3f2a1b9c.webp');
    expect(first).not.toBe(second);
  });

  test('is stable, so re-downloading replaces the file rather than adding one', () => {
    const map = { name: 'River Crossing', variant: 'day', uuid };
    expect(downloadFilename(map)).toBe(downloadFilename(map));
  });

  test('emits nothing that could break out of the Content-Disposition header', () => {
    const hostile = downloadFilename({ name: 'a"; rm -rf /\r\nX-Evil: 1', variant: '', uuid });
    expect(hostile).toMatch(/^[a-z0-9-]+\.webp$/);
  });

  test('never doubles a separator where truncation lands on one', () => {
    const name = `${'x'.repeat(78)} tail`;
    expect(downloadFilename({ name, variant: '', uuid })).not.toContain('--');
  });
});
