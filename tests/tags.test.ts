/** Tag normalisation and FTS query construction, including injection attempts. */
import { describe, expect, test } from 'bun:test';

import {
  buildMatchExpression,
  parseTagInput,
  parseTags,
  serialiseTags,
} from '../src/models/maps.ts';

describe('parseTagInput', () => {
  test('splits on spaces and commas, lowercases, de-duplicates and sorts', () => {
    const { tags, rejected } = parseTagInput('Road, forest  ROAD,camp');
    expect(tags).toEqual(['camp', 'forest', 'road']);
    expect(rejected).toEqual([]);
  });

  test('rejects anything that is not letters rather than silently dropping it', () => {
    const { tags, rejected } = parseTagInput('forest road! camp-site 123 ok');
    expect(tags).toEqual(['forest', 'ok']);
    expect(rejected).toEqual(['road!', 'camp-site', '123']);
  });

  test('handles empty and whitespace-only input', () => {
    expect(parseTagInput('').tags).toEqual([]);
    expect(parseTagInput('   ,  , ').tags).toEqual([]);
  });

  test('rejects an over-long tag', () => {
    const { tags, rejected } = parseTagInput('a'.repeat(33));
    expect(tags).toEqual([]);
    expect(rejected).toHaveLength(1);
  });
});

describe('tag serialisation', () => {
  test('pads with spaces so a LIKE cannot match a partial tag', () => {
    expect(serialiseTags(['forest', 'road'])).toBe(' forest road ');
    // Without the padding, '%road%' would also match 'crossroads'.
    expect(serialiseTags(['crossroads']).includes(' road ')).toBe(false);
  });

  test('empty tag list serialises to an empty string', () => {
    expect(serialiseTags([])).toBe('');
  });

  test('round-trips', () => {
    expect(parseTags(serialiseTags(['camp', 'desert']))).toEqual(['camp', 'desert']);
    expect(parseTags('')).toEqual([]);
  });
});

describe('buildMatchExpression', () => {
  test('returns null when nothing was searched for', () => {
    expect(buildMatchExpression(undefined, [], 'any')).toBeNull();
    expect(buildMatchExpression('   ', [], 'any')).toBeNull();
  });

  test('joins tags with OR in any mode and AND in all mode', () => {
    expect(buildMatchExpression(undefined, ['forest', 'road'], 'any')).toBe('tags:("forest" OR "road")');
    expect(buildMatchExpression(undefined, ['forest', 'road'], 'all')).toBe('tags:("forest" AND "road")');
  });

  test('requires every name word, prefix-matching the last', () => {
    expect(buildMatchExpression('river cross', [], 'any')).toBe('name:("river" AND "cross"*)');
  });

  test('combines name and tag clauses', () => {
    expect(buildMatchExpression('river', ['forest'], 'any')).toBe('tags:("forest") AND name:("river"*)');
  });

  describe('treats FTS5 operators as literal text, not syntax', () => {
    // Each of these would change the query's meaning, or make it a syntax
    // error, if the term were interpolated unquoted.
    const attacks: [string, string][] = [
      ['forest OR everything', 'name:("forest" AND "OR" AND "everything"*)'],
      ['NEAR/2', 'name:("NEAR/2"*)'],
      ['*', 'name:("*"*)'],
      ['a" OR "b', 'name:("a""" AND "OR" AND """b"*)'],
      ['(evil)', 'name:("(evil)"*)'],
      ['^anchored', 'name:("^anchored"*)'],
    ];

    for (const [input, expected] of attacks) {
      test(JSON.stringify(input), () => {
        expect(buildMatchExpression(input, [], 'any')).toBe(expected);
      });
    }
  });

  test('quotes tag terms too, even though they are already restricted', () => {
    expect(buildMatchExpression(undefined, ['a"b'], 'any')).toBe('tags:("a""b")');
  });
});
