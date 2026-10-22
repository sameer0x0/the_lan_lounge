import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('maps UK formats to the same key', () => {
    for (const raw of ['07700 900123', '+44 7700 900123', '0044 7700-900123', '+44 (0) 7700 900123', '7700900123']) {
      expect(normalizePhone(raw)).toBe('7700900123');
    }
  });
  it('maps Bangladesh formats to the same key', () => {
    expect(normalizePhone('+880 1712-345678')).toBe('1712345678');
    expect(normalizePhone('01712345678')).toBe('1712345678');
  });
  it('rejects junk and wrong lengths', () => {
    for (const raw of ['', 'abc', '123', '12345678901234', '07700 90x123']) expect(normalizePhone(raw)).toBeNull();
  });
  it('keeps other country codes distinct', () => {
    expect(normalizePhone('+1 415 555 0132')).toBe('14155550132');
  });
});
