import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CARD_BACK, buildDeck, cardAsset } from './uno';

const publicDir = fileURLToPath(new URL('../../../apps/web/public', import.meta.url));

describe('card images', () => {
  it('every card in the deck has an image file (run `npm run cards` if this fails)', () => {
    const missing = buildDeck()
      .map(cardAsset)
      .filter((a) => !existsSync(publicDir + a));
    expect(missing).toEqual([]);
  });
  it('has a card back, and 54 distinct faces for 108 cards', () => {
    expect(existsSync(publicDir + CARD_BACK)).toBe(true);
    expect(new Set(buildDeck().map(cardAsset)).size).toBe(54);
  });
  it('a second deck needs no extra images: the same 54 faces', () => {
    expect(new Set(buildDeck(2).map(cardAsset)).size).toBe(54);
  });
  it('names are stable', () => {
    expect(cardAsset({ color: 'red', kind: 'number', value: 5 })).toBe('/cards/red-5.svg');
    expect(cardAsset({ color: 'blue', kind: 'draw2', value: null })).toBe('/cards/blue-draw2.svg');
    expect(cardAsset({ color: 'wild', kind: 'wild4', value: null })).toBe('/cards/wild4.svg');
  });
});
