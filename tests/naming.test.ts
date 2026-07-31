/** Deriving a map name from the name of the uploaded file. */
import { describe, expect, test } from 'bun:test';

import { MAX_NAME_LENGTH, nameFromFilename } from '../src/models/maps.ts';

describe('nameFromFilename', () => {
  test('drops the extension and turns separators into spaced words', () => {
    expect(nameFromFilename('forest_road-01.png')).toBe('Forest Road 01');
  });

  test('leaves a name that already reads well alone', () => {
    expect(nameFromFilename('River Crossing.webp')).toBe('River Crossing');
  });

  test('capitalises the first character of each word, not the first letter', () => {
    // "(" is the word's first character, so "night" is left as it was written.
    expect(nameFromFilename('map 2 (night).jpg')).toBe('Map 2 (night)');
  });

  test('preserves capitalisation inside a word', () => {
    expect(nameFromFilename('DUNGEON of the mad mage.png')).toBe('DUNGEON Of The Mad Mage');
  });

  test('keeps only the last path segment', () => {
    expect(nameFromFilename('C:\\Users\\alex\\maps\\sunken_temple.png')).toBe('Sunken Temple');
    expect(nameFromFilename('/home/alex/maps/sunken_temple.png')).toBe('Sunken Temple');
  });

  test('keeps a leading-dot name rather than deriving nothing from it', () => {
    expect(nameFromFilename('.png')).toBe('.png');
  });

  test('accepts a filename with no extension', () => {
    expect(nameFromFilename('goblin camp')).toBe('Goblin Camp');
  });

  test('collapses runs of separators and whitespace', () => {
    expect(nameFromFilename('old__mill---pond  v2.png')).toBe('Old Mill Pond V2');
  });

  test('truncates to the name column limit', () => {
    const derived = nameFromFilename(`${'a'.repeat(250)}.png`);
    expect(derived.length).toBe(MAX_NAME_LENGTH);
  });

  test('returns empty when there is nothing usable, leaving validation to speak', () => {
    expect(nameFromFilename('')).toBe('');
    expect(nameFromFilename('___.png')).toBe('');
    expect(nameFromFilename('   ')).toBe('');
  });
});
