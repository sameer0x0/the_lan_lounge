/**
 * Writes the UNO-style card images to apps/web/public/cards/ (run with `npm run cards`).
 * Original artwork, not the official UNO design. File names come from `cardAsset` so the UI and this
 * script can never disagree. Output is deterministic, so re-running produces identical files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_BACK, UNO_COLORS, cardAsset, type CardKind, type UnoColor } from '../packages/shared/src/uno';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web/public');

/** Card background, and a symbol colour that still reads on the white oval (yellow needs a darker tone). */
const PALETTE: Record<UnoColor, { bg: string; ink: string }> = {
  red: { bg: '#D32F2F', ink: '#D32F2F' },
  yellow: { bg: '#FBC02D', ink: '#E08E00' },
  green: { bg: '#2E7D32', ink: '#2E7D32' },
  blue: { bg: '#1565C0', ink: '#1565C0' },
};
const WILD_BG = '#1B1B24';
const FONT = `font-family="'Arial Black', 'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="900" text-anchor="middle"`;

type Face = { kind: CardKind; value: number | null };

/** The big symbol, drawn around (0,0) and roughly 120 units tall. `ink` colours the shapes. */
function symbol(face: Face, ink: string): string {
  switch (face.kind) {
    case 'number': {
      const underline = face.value === 6 || face.value === 9 ? `<rect x="-30" y="74" width="60" height="11" rx="5" fill="${ink}"/>` : '';
      return `<text x="0" y="54" font-size="150" ${FONT} fill="${ink}">${face.value}</text>${underline}`;
    }
    case 'skip':
      return `<circle r="50" fill="none" stroke="${ink}" stroke-width="20"/><line x1="-36" y1="36" x2="36" y2="-36" stroke="${ink}" stroke-width="20" stroke-linecap="round"/>`;
    case 'reverse': {
      const arrow = `<path d="M-52,-28 H14 V-52 L58,-18 L14,16 V-8 H-52 Z" fill="${ink}"/>`;
      return `<g transform="translate(0 -22)">${arrow}</g><g transform="rotate(180) translate(0 -22)">${arrow}</g>`;
    }
    case 'draw2':
      return (
        `<rect x="-46" y="-62" width="54" height="80" rx="9" fill="${ink}" stroke="#fff" stroke-width="5" transform="rotate(-14 -19 -22)"/>` +
        `<rect x="-6" y="-52" width="54" height="80" rx="9" fill="${ink}" stroke="#fff" stroke-width="5" transform="rotate(10 21 -12)"/>` +
        `<text x="0" y="86" font-size="52" ${FONT} fill="${ink}">+2</text>`
      );
    case 'wild':
      return wheel(62);
    case 'wild4': {
      const fan = (['red', 'yellow', 'green', 'blue'] as const)
        .map((c, i) => `<rect x="-17" y="-72" width="34" height="54" rx="6" fill="${PALETTE[c].bg}" stroke="#fff" stroke-width="4" transform="rotate(${-33 + i * 22} 0 18)"/>`)
        .join('');
      return `${fan}<text x="0" y="88" font-size="52" ${FONT} fill="#1B1B24">+4</text>`;
    }
  }
}

/** Four-colour wheel used by both Wild cards. */
function wheel(r: number): string {
  const q = (a0: number, a1: number, fill: string) => {
    const p = (a: number) => `${(r * Math.sin(a)).toFixed(2)},${(-r * Math.cos(a)).toFixed(2)}`;
    return `<path d="M0,0 L${p(a0)} A${r},${r} 0 0 1 ${p(a1)} Z" fill="${fill}"/>`;
  };
  const h = Math.PI / 2;
  return (
    q(0, h, PALETTE.red.bg) + q(h, 2 * h, PALETTE.blue.bg) + q(2 * h, 3 * h, PALETTE.yellow.bg) + q(3 * h, 4 * h, PALETTE.green.bg) +
    `<circle r="${r}" fill="none" stroke="#fff" stroke-width="6"/>`
  );
}

/** Small corner mark: a mini number/symbol for coloured cards, a mini wheel for wilds. */
function corner(face: Face): string {
  if (face.kind === 'wild' || face.kind === 'wild4') return wheel(15);
  if (face.kind === 'number') return `<text x="0" y="13" font-size="38" ${FONT} fill="#fff">${face.value}</text>`;
  return `<g transform="scale(0.3)">${symbol(face, '#fff')}</g>`;
}

function cardSvg(bg: string, ink: string, face: Face): string {
  const wild = face.kind === 'wild' || face.kind === 'wild4';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 360" width="240" height="360">` +
    `<rect x="4" y="4" width="232" height="352" rx="28" fill="#fff"/>` +
    `<rect x="14" y="14" width="212" height="332" rx="20" fill="${bg}"/>` +
    `<ellipse cx="120" cy="180" rx="80" ry="130" fill="#fff" transform="rotate(32 120 180)"/>` +
    `<g transform="translate(120 ${wild && face.kind === 'wild' ? 180 : 176})">${symbol(face, ink)}</g>` +
    `<g transform="translate(46 52)">${corner(face)}</g>` +
    `<g transform="translate(194 308) rotate(180)">${corner(face)}</g>` +
    `</svg>\n`
  );
}

const backSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 360" width="240" height="360">` +
  `<rect x="4" y="4" width="232" height="352" rx="28" fill="#fff"/>` +
  `<rect x="14" y="14" width="212" height="332" rx="20" fill="#14141C"/>` +
  `<ellipse cx="120" cy="180" rx="80" ry="130" fill="${PALETTE.red.bg}" transform="rotate(32 120 180)"/>` +
  `<text x="120" y="204" font-size="76" ${FONT} fill="${PALETTE.yellow.bg}" transform="rotate(-18 120 180)">PN</text>` +
  `</svg>\n`;

const files = new Map<string, string>();
files.set(CARD_BACK, backSvg);
for (const color of UNO_COLORS) {
  const { bg, ink } = PALETTE[color];
  for (let v = 0; v <= 9; v++) files.set(cardAsset({ color, kind: 'number', value: v }), cardSvg(bg, ink, { kind: 'number', value: v }));
  for (const kind of ['skip', 'reverse', 'draw2'] as const) {
    files.set(cardAsset({ color, kind, value: null }), cardSvg(bg, ink, { kind, value: null }));
  }
}
files.set(cardAsset({ color: 'wild', kind: 'wild', value: null }), cardSvg(WILD_BG, '#fff', { kind: 'wild', value: null }));
files.set(cardAsset({ color: 'wild', kind: 'wild4', value: null }), cardSvg(WILD_BG, '#fff', { kind: 'wild4', value: null }));

for (const [asset, svg] of files) {
  const file = resolve(publicDir, asset.slice(1));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, svg);
}
console.log(`Wrote ${files.size} card images to ${resolve(publicDir, 'cards')}`);
