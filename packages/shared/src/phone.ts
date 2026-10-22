/**
 * Canonical phone key: national digits with no country code and no leading 0.
 * "+44 7700 900123", "0044 7700900123" and "07700 900123" all become "7700900123".
 * Only +44 and +880 are stripped; other country codes keep their digits so they stay distinct.
 * Returns null when the input can't be a phone number.
 */
export function normalizePhone(raw: string): string | null {
  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;

  let international = false;
  if (s.startsWith('+')) {
    international = true;
    s = s.slice(1);
  } else if (s.startsWith('00')) {
    international = true;
    s = s.slice(2);
  }

  if (international) {
    if (s.startsWith('880')) s = s.slice(3);
    else if (s.startsWith('44')) s = s.slice(2);
  }
  if (s.startsWith('0')) s = s.slice(1);

  return /^\d{7,12}$/.test(s) ? s : null;
}
