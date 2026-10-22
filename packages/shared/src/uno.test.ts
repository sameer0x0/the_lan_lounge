import { describe, expect, it } from 'vitest';
import {
  UNO_COLORS,
  UnoError,
  buildDeck,
  callUno,
  cardPoints,
  catchUno,
  deckCountFor,
  challengeDrawFour,
  createUnoGame,
  drawCard,
  isPlayable,
  legalPlays,
  nextUnoRound,
  passTurn,
  playCard,
  skipTurn,
  unoViewFor,
  type CardKind,
  type UnoCard,
  type UnoColor,
  type UnoState,
} from './uno';

// ---- helpers ---------------------------------------------------------------

/** Small seeded RNG (mulberry32) so shuffles are repeatable. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 1000; // rigged cards live above the real deck's 0-107
const mk = (color: UnoCard['color'], kind: CardKind, value: number | null = null): UnoCard => ({ id: nextId++, color, kind, value });
const num = (color: UnoColor, v: number) => mk(color, 'number', v);
const act = (color: UnoColor, kind: 'skip' | 'reverse' | 'draw2') => mk(color, kind);
const wild = () => mk('wild', 'wild');
const wild4 = () => mk('wild', 'wild4');
/** Filler that matches nothing interesting and is never the top card. */
const filler = (n: number) => Array.from({ length: n }, () => num('blue', 9));

interface Rig {
  players?: string[];
  hands?: Record<string, UnoCard[]>;
  top?: UnoCard;
  color?: UnoColor | null;
  current?: number;
  direction?: 1 | -1;
  /** Draw pile, listed so the LAST entry is drawn first. */
  pile?: UnoCard[];
  discardBelow?: UnoCard[];
  targetScore?: number;
}

/** A playing-phase state where seat 0 ('a') is to act, top card red 5, everyone holding 3 filler cards unless told. */
function rig(o: Rig = {}): UnoState {
  const ids = o.players ?? ['a', 'b', 'c'];
  const s: UnoState = JSON.parse(JSON.stringify(createUnoGame(ids, { targetScore: o.targetScore }, seeded(1))));
  s.phase = 'playing';
  s.current = o.current ?? 0;
  s.direction = o.direction ?? 1;
  s.drawn = null;
  s.challenge = null;
  s.unoPending = null;
  s.log = [];
  const top = o.top ?? num('red', 5);
  s.discard = [...(o.discardBelow ?? []), top];
  s.activeColor = o.color === undefined ? (top.color === 'wild' ? null : top.color) : o.color;
  s.drawPile = o.pile ?? filler(40);
  for (const p of s.players) {
    p.hand = o.hands?.[p.id] ?? filler(3);
    p.calledUno = false;
    p.score = 0;
  }
  return s;
}

const hand = (s: UnoState, id: string) => s.players.find((p) => p.id === id)!.hand;
const ids = (cards: UnoCard[]) => cards.map((c) => c.id);
const throwsUno = (fn: () => unknown, msg?: RegExp) => {
  expect(fn).toThrow(UnoError);
  if (msg) expect(fn).toThrow(msg);
};
const totalCards = (s: UnoState) => s.drawPile.length + s.discard.length + s.players.reduce((n, p) => n + p.hand.length, 0);

// ---- deck ------------------------------------------------------------------

describe('deck', () => {
  const deck = buildDeck();
  const count = (f: (c: UnoCard) => boolean) => deck.filter(f).length;

  it('has the 108 standard cards with unique ids', () => {
    expect(deck).toHaveLength(108);
    expect(new Set(deck.map((c) => c.id)).size).toBe(108);
  });
  it('has 25 cards per colour: one 0, two of 1-9, two each Skip, Reverse, Draw Two', () => {
    for (const color of UNO_COLORS) {
      expect(count((c) => c.color === color)).toBe(25);
      expect(count((c) => c.color === color && c.value === 0)).toBe(1);
      for (let v = 1; v <= 9; v++) expect(count((c) => c.color === color && c.value === v)).toBe(2);
      for (const k of ['skip', 'reverse', 'draw2'] as const) expect(count((c) => c.color === color && c.kind === k)).toBe(2);
    }
  });
  it('a second deck doubles everything with ids still unique', () => {
    const two = buildDeck(2);
    expect(two).toHaveLength(216);
    expect(new Set(two.map((c) => c.id)).size).toBe(216);
    expect(two.filter((c) => c.kind === 'wild4')).toHaveLength(8);
    expect(two.filter((c) => c.color === 'red' && c.value === 0)).toHaveLength(2);
  });
  it('has 4 Wild and 4 Wild Draw Four', () => {
    expect(count((c) => c.kind === 'wild')).toBe(4);
    expect(count((c) => c.kind === 'wild4')).toBe(4);
  });
  it('scores numbers at face value, Skip/Reverse/Draw Two at 20, Wilds at 50', () => {
    expect(cardPoints(num('red', 7))).toBe(7);
    expect(cardPoints(num('red', 0))).toBe(0);
    for (const k of ['skip', 'reverse', 'draw2'] as const) expect(cardPoints(act('red', k))).toBe(20);
    expect(cardPoints(wild())).toBe(50);
    expect(cardPoints(wild4())).toBe(50);
  });
});

// ---- setup -----------------------------------------------------------------

describe('createUnoGame', () => {
  it('deals 7 each, flips one card, and keeps every card accounted for', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = createUnoGame(['a', 'b', 'c', 'd'], {}, seeded(seed));
      for (const p of s.players) expect(p.hand.length).toBeGreaterThanOrEqual(7);
      expect(s.discard).toHaveLength(1);
      expect(totalCards(s)).toBe(108);
      expect(new Set([...s.drawPile, ...s.discard, ...s.players.flatMap((p) => p.hand)].map((c) => c.id)).size).toBe(108);
    }
  });
  it('uses one deck up to 10 players and two decks for 11-20, so everyone gets 7 cards', () => {
    expect([2, 10].map(deckCountFor)).toEqual([1, 1]);
    expect([11, 15, 20].map(deckCountFor)).toEqual([2, 2, 2]);
    for (let n = 2; n <= 20; n++) {
      const s = createUnoGame(Array.from({ length: n }, (_, i) => `p${i}`), {}, seeded(n));
      const shoe = 108 * deckCountFor(n);
      expect(totalCards(s)).toBe(shoe);
      expect(new Set([...s.drawPile, ...s.discard, ...s.players.flatMap((p) => p.hand)].map((c) => c.id)).size).toBe(shoe);
      for (const p of s.players) expect(p.hand.length).toBeGreaterThanOrEqual(7);
      expect(s.drawPile.length).toBeGreaterThan(20); // a real draw pile is left even with 20 players
    }
  });
  it('a 20-player table plays on: opening card is never a Wild Draw Four, every phone view builds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const s = createUnoGame(Array.from({ length: 20 }, (_, i) => `p${i}`), {}, seeded(seed));
      expect(s.discard[0]!.kind).not.toBe('wild4');
      expect(unoViewFor(s, 'p19').players).toHaveLength(20);
    }
  });
  it('never starts with a Wild Draw Four', () => {
    for (let seed = 0; seed < 500; seed++) expect(createUnoGame(['a', 'b'], {}, seeded(seed)).discard[0]!.kind).not.toBe('wild4');
  });
  it('rejects bad player counts, duplicates and targets', () => {
    throwsUno(() => createUnoGame(['a']));
    throwsUno(() => createUnoGame(Array.from({ length: 21 }, (_, i) => `p${i}`)), /2-20 players/);
    throwsUno(() => createUnoGame(['a', 'a']));
    throwsUno(() => createUnoGame(['a', 'b'], { targetScore: 0 }));
    expect(createUnoGame(Array.from({ length: 20 }, (_, i) => `p${i}`)).players).toHaveLength(20);
  });
  it('defaults the target to 500 and lets the host lower it', () => {
    expect(createUnoGame(['a', 'b']).settings.targetScore).toBe(500);
    expect(createUnoGame(['a', 'b'], { targetScore: 100 }).settings.targetScore).toBe(100);
  });

  const withOpening = (kind: CardKind, n: number) => {
    for (let seed = 0; seed < 5000; seed++) {
      const s = createUnoGame(Array.from({ length: n }, (_, i) => `p${i}`), {}, seeded(seed));
      if (s.discard[0]!.kind === kind) return s;
    }
    throw new Error(`no seed opens with ${kind}`);
  };

  it('opening Skip skips the first player', () => {
    const s = withOpening('skip', 3);
    expect(s.current).toBe(1); // seat 0 would start, skipped
  });
  it('opening Draw Two makes the first player draw 2 and lose their turn', () => {
    const s = withOpening('draw2', 3);
    expect(s.players[0]!.hand).toHaveLength(9);
    expect(s.current).toBe(1);
  });
  it('opening Reverse flips direction (dealer starts), and acts as Skip with 2 players', () => {
    const three = withOpening('reverse', 3);
    expect(three.direction).toBe(-1);
    expect(three.current).toBe(2); // the dealer
    const two = withOpening('reverse', 2);
    expect(two.direction).toBe(1);
    expect(two.current).toBe(1);
  });
  it('opening Wild leaves the colour open so the first player can play anything', () => {
    const s = withOpening('wild', 3);
    expect(s.activeColor).toBeNull();
    for (const c of s.players[0]!.hand) expect(isPlayable(s, c)).toBe(true);
  });
});

// ---- legality --------------------------------------------------------------

describe('playing cards', () => {
  it('allows matching colour, number, or symbol, and any Wild', () => {
    const s = rig({ top: num('red', 5) });
    expect(isPlayable(s, num('red', 9))).toBe(true); // colour
    expect(isPlayable(s, num('blue', 5))).toBe(true); // number
    expect(isPlayable(s, num('blue', 6))).toBe(false);
    expect(isPlayable(s, act('blue', 'skip'))).toBe(false);
    expect(isPlayable(s, wild())).toBe(true);
    expect(isPlayable(s, wild4())).toBe(true);

    const skipTop = rig({ top: act('red', 'skip') });
    expect(isPlayable(skipTop, act('blue', 'skip'))).toBe(true); // symbol
    expect(isPlayable(skipTop, act('blue', 'draw2'))).toBe(false);
    expect(isPlayable(skipTop, num('blue', 5))).toBe(false);
  });
  it('after a Wild only the chosen colour (or another Wild) matches', () => {
    const s = rig({ top: wild(), color: 'green' });
    expect(isPlayable(s, num('green', 2))).toBe(true);
    expect(isPlayable(s, num('red', 5))).toBe(false);
  });
  it('plays a card, moves it to the discard pile and advances the turn', () => {
    const card = num('red', 9);
    const s = playCard(rig({ hands: { a: [card, num('blue', 1)] } }), 'a', card.id);
    expect(s.discard.at(-1)).toEqual(card);
    expect(ids(hand(s, 'a'))).not.toContain(card.id);
    expect(s.current).toBe(1);
    expect(s.activeColor).toBe('red');
  });
  it('rejects plays out of turn, cards you do not hold, and non-matching cards', () => {
    const card = num('red', 9);
    const base = rig({ hands: { a: [num('blue', 1), num('blue', 2)], b: [card, num('blue', 3)] } });
    throwsUno(() => playCard(base, 'b', card.id), /not your turn/);
    throwsUno(() => playCard(base, 'a', card.id), /do not have/);
    const bad = hand(base, 'a')[0]!;
    throwsUno(() => playCard(base, 'a', bad.id), /match/);
    throwsUno(() => playCard(base, 'zed', 1), /not in this game/);
  });
  it('requires a valid colour with a Wild, and sets it', () => {
    const w = wild();
    const base = rig({ hands: { a: [w, num('blue', 1)] } });
    throwsUno(() => playCard(base, 'a', w.id), /Choose a colour/);
    throwsUno(() => playCard(base, 'a', w.id, 'purple' as UnoColor), /Choose a colour/);
    const s = playCard(base, 'a', w.id, 'green');
    expect(s.activeColor).toBe('green');
    expect(s.current).toBe(1);
  });
  it('does not mutate the state it was given', () => {
    const card = num('red', 9);
    const base = rig({ hands: { a: [card, num('blue', 1)] } });
    const before = JSON.stringify(base);
    playCard(base, 'a', card.id);
    drawCard(base, 'a');
    expect(JSON.stringify(base)).toBe(before);
  });
  it('legalPlays lists only playable cards for the player whose turn it is', () => {
    const r9 = num('red', 9);
    const s = rig({ hands: { a: [r9, num('blue', 1), wild()] } });
    expect(legalPlays(s, 'a')).toEqual([r9.id, hand(s, 'a')[2]!.id]);
    expect(legalPlays(s, 'b')).toEqual([]);
  });
});

describe('action cards', () => {
  it('Skip: the next player loses their turn', () => {
    const k = act('red', 'skip');
    const s = playCard(rig({ hands: { a: [k, num('blue', 1)] } }), 'a', k.id);
    expect(s.current).toBe(2);
  });
  it('Reverse: flips direction (3+ players), so play now runs the other way', () => {
    const k = act('red', 'reverse');
    const s = playCard(rig({ hands: { a: [k, num('blue', 1)] } }), 'a', k.id);
    expect(s.direction).toBe(-1);
    expect(s.current).toBe(2); // a -> c now
    const r = num('red', 1);
    s.players[2]!.hand.push(r);
    expect(playCard(s, 'c', r.id).current).toBe(1); // c -> b
  });
  it('Reverse acts as Skip with two players', () => {
    const k = act('red', 'reverse');
    const s = playCard(rig({ players: ['a', 'b'], hands: { a: [k, num('blue', 1)] } }), 'a', k.id);
    expect(s.current).toBe(0);
  });
  it('Draw Two: the next player draws 2 and loses their turn', () => {
    const k = act('red', 'draw2');
    const s = playCard(rig({ hands: { a: [k, num('blue', 1)] } }), 'a', k.id);
    expect(hand(s, 'b')).toHaveLength(5);
    expect(s.current).toBe(2);
  });
  it('turns run the other way when direction is reversed', () => {
    const card = num('red', 9);
    const s = playCard(rig({ direction: -1, hands: { a: [card, num('blue', 1)] } }), 'a', card.id);
    expect(s.current).toBe(2);
  });
});

// ---- drawing ---------------------------------------------------------------

describe('drawing', () => {
  it('draws one card and ends the turn when it cannot be played', () => {
    const s = drawCard(rig({ pile: [...filler(5)] }), 'a'); // blue 9 on red 5: unplayable
    expect(hand(s, 'a')).toHaveLength(4);
    expect(s.drawn).toBeNull();
    expect(s.current).toBe(1);
  });
  it('lets you play (or pass) a drawn card that matches, but nothing else', () => {
    const match = num('red', 7);
    const other = num('red', 2);
    const base = rig({ hands: { a: [other, num('blue', 1)] }, pile: [...filler(5), match] });
    const s = drawCard(base, 'a');
    expect(s.drawn).toBe(match.id);
    expect(s.current).toBe(0);
    expect(legalPlays(s, 'a')).toEqual([match.id]);
    throwsUno(() => playCard(s, 'a', other.id), /just drew/);
    throwsUno(() => drawCard(s, 'a'), /already drew/);
    expect(playCard(s, 'a', match.id).current).toBe(1);
    const passed = passTurn(s, 'a');
    expect(passed.current).toBe(1);
    expect(hand(passed, 'a')).toHaveLength(3); // kept the card
  });
  it('cannot pass without drawing first', () => {
    throwsUno(() => passTurn(rig(), 'a'), /Draw a card first/);
  });
  it('can draw even when holding a playable card (you "won\'t" play)', () => {
    const s = drawCard(rig({ hands: { a: [num('red', 1), num('blue', 1)] } }), 'a');
    expect(hand(s, 'a')).toHaveLength(3);
  });
  it('reshuffles the discard pile (except the top card) when the draw pile runs out', () => {
    const under = [num('green', 1), num('green', 2), num('green', 3)];
    const top = num('red', 5);
    const base = rig({ top, pile: [], discardBelow: under });
    const s = drawCard(base, 'a');
    expect(s.discard).toEqual([top]);
    expect(s.drawPile.length + hand(s, 'a').length).toBe(3 + 3); // 3 reshuffled cards + the hand's 3 filler
    expect(hand(s, 'a')).toHaveLength(4);
    expect(s.log.some((e) => e.kind === 'reshuffle')).toBe(true);
    expect(totalCards(s)).toBe(totalCards(base));
  });
  it('does not loop forever when there are no cards left anywhere', () => {
    const s = drawCard(rig({ pile: [] }), 'a');
    expect(hand(s, 'a')).toHaveLength(3);
    expect(s.current).toBe(1);
  });
});

// ---- Wild Draw Four --------------------------------------------------------

describe('Wild Draw Four', () => {
  it('opens a challenge window for the next player', () => {
    const w = wild4();
    const s = playCard(rig({ hands: { a: [w, num('blue', 1)] } }), 'a', w.id, 'blue');
    expect(s.phase).toBe('challenge');
    expect(s.current).toBe(1);
    expect(s.activeColor).toBe('blue');
    throwsUno(() => playCard(s, 'b', hand(s, 'b')[0]!.id), /Wild Draw Four first/);
  });
  it('accepting (draw) gives 4 cards and skips the turn', () => {
    const w = wild4();
    let s = playCard(rig({ hands: { a: [w, num('blue', 1)] } }), 'a', w.id, 'blue');
    s = drawCard(s, 'b');
    expect(hand(s, 'b')).toHaveLength(7);
    expect(s.phase).toBe('playing');
    expect(s.current).toBe(2);
  });
  it('challenging a bluff (had the current colour): the player draws 4 instead, challenger plays on', () => {
    const w = wild4();
    let s = playCard(rig({ hands: { a: [w, num('red', 1), num('blue', 1)] } }), 'a', w.id, 'blue'); // held red 1 on red
    s = challengeDrawFour(s, 'b');
    expect(hand(s, 'a')).toHaveLength(6);
    expect(hand(s, 'b')).toHaveLength(3);
    expect(s.phase).toBe('playing');
    expect(s.current).toBe(1);
    expect(s.activeColor).toBe('blue');
  });
  it('challenging an honest play: the challenger draws 6 and loses their turn', () => {
    const w = wild4();
    let s = playCard(rig({ hands: { a: [w, num('blue', 1)] } }), 'a', w.id, 'green'); // no red in hand
    s = challengeDrawFour(s, 'b');
    expect(hand(s, 'b')).toHaveLength(9);
    expect(hand(s, 'a')).toHaveLength(1);
    expect(s.current).toBe(2);
    expect(s.phase).toBe('playing');
  });
  it('only the targeted player may challenge, and only when there is something to challenge', () => {
    const w = wild4();
    const s = playCard(rig({ hands: { a: [w, num('blue', 1)] } }), 'a', w.id, 'green');
    throwsUno(() => challengeDrawFour(s, 'c'), /not your turn/);
    throwsUno(() => challengeDrawFour(s, 'a'), /not your turn/);
    throwsUno(() => challengeDrawFour(rig(), 'a'), /nothing to challenge/);
  });
  it('playing the Draw Four as your last card wins immediately, the next player still takes 4', () => {
    const w = wild4();
    const s = playCard(rig({ hands: { a: [w], b: [num('blue', 7)], c: [num('blue', 2)] }, pile: filler(10) }), 'a', w.id, 'red');
    expect(s.phase).toBe('roundOver');
    expect(hand(s, 'b')).toHaveLength(5);
    expect(s.roundPoints).toBe(7 + 9 * 4 + 2);
  });
  it('the challenge does not leak whether it was a bluff', () => {
    const w = wild4();
    const s = playCard(rig({ hands: { a: [w, num('red', 1)] } }), 'a', w.id, 'blue');
    const view = unoViewFor(s, 'b');
    expect(view.challenge).toEqual({ fromId: 'a', targetId: 'b' });
    expect(JSON.stringify(view)).not.toMatch(/bluff/i);
    expect(view.canDraw).toBe(true);
  });
});

// ---- UNO call / catch ------------------------------------------------------

describe('UNO call and Catch', () => {
  const twoCards = () => {
    const play = num('red', 9);
    return { play, base: rig({ hands: { a: [play, num('blue', 1)] } }) };
  };

  it('dropping to one card without calling leaves you catchable; catching makes you draw 2', () => {
    const { play, base } = twoCards();
    let s = playCard(base, 'a', play.id);
    expect(s.unoPending).toBe('a');
    expect(unoViewFor(s, 'c').catchable).toBe('a');
    s = catchUno(s, 'c');
    expect(hand(s, 'a')).toHaveLength(3);
    expect(s.unoPending).toBeNull();
    throwsUno(() => catchUno(s, 'c'), /Nobody to catch/);
  });
  it('calling UNO right after dropping to one clears the Catch window', () => {
    const { play, base } = twoCards();
    let s = playCard(base, 'a', play.id);
    s = callUno(s, 'a');
    expect(s.unoPending).toBeNull();
    throwsUno(() => catchUno(s, 'b'), /Nobody to catch/);
  });
  it('calling UNO while holding two cards protects the play that drops you to one', () => {
    const { play, base } = twoCards();
    let s = callUno(base, 'a');
    s = playCard(s, 'a', play.id);
    expect(s.unoPending).toBeNull();
  });
  it('you can no longer be caught once the next player has acted', () => {
    const { play, base } = twoCards();
    let s = playCard(base, 'a', play.id);
    s = drawCard(s, 'b');
    expect(s.unoPending).toBeNull();
    throwsUno(() => catchUno(s, 'c'), /Nobody to catch/);
  });
  it('cannot catch yourself, and UNO needs one or two cards', () => {
    const { play, base } = twoCards();
    const s = playCard(base, 'a', play.id);
    throwsUno(() => catchUno(s, 'a'), /catch yourself/);
    throwsUno(() => callUno(rig(), 'a'), /one or two cards/);
  });
  it('the called flag resets once you pick up to three or more cards', () => {
    const base = rig({ hands: { a: [num('blue', 1), num('blue', 2)] }, pile: filler(5) });
    let s = callUno(base, 'a');
    expect(s.players[0]!.calledUno).toBe(true);
    s = drawCard(s, 'a');
    expect(s.players[0]!.calledUno).toBe(false);
  });
  it('a Draw Two that drops you to one card still gives you a Catch window', () => {
    const k = act('red', 'draw2');
    const s = playCard(rig({ hands: { a: [k, num('blue', 1)] } }), 'a', k.id);
    expect(s.unoPending).toBe('a');
  });
});

// ---- turn skipping (timeouts / host) ---------------------------------------

describe('skipTurn', () => {
  it('moves on without the player acting', () => {
    const s = skipTurn(rig());
    expect(s.current).toBe(1);
    expect(hand(s, 'a')).toHaveLength(3);
  });
  it('drops a pending drawn card', () => {
    const match = num('red', 7);
    const s = skipTurn(drawCard(rig({ pile: [match] }), 'a'));
    expect(s.drawn).toBeNull();
    expect(s.current).toBe(1);
  });
  it('counts as accepting a Wild Draw Four', () => {
    const w = wild4();
    let s = playCard(rig({ hands: { a: [w, num('blue', 1)] } }), 'a', w.id, 'blue');
    s = skipTurn(s);
    expect(hand(s, 'b')).toHaveLength(7);
    expect(s.phase).toBe('playing');
    expect(s.current).toBe(2);
  });
});

// ---- scoring & rounds ------------------------------------------------------

describe('winning a round', () => {
  const finish = (opts: Rig = {}) => {
    const last = num('red', 9);
    const base = rig({
      hands: { a: [last], b: [num('blue', 7), act('blue', 'skip'), wild()], c: [act('green', 'draw2')] },
      ...opts,
    });
    return playCard(base, 'a', last.id);
  };

  it('scores opponents\' cards: numbers face value, action 20, wild 50', () => {
    const s = finish();
    expect(s.phase).toBe('roundOver');
    expect(s.roundWinnerId).toBe('a');
    expect(s.roundPoints).toBe(7 + 20 + 50 + 20);
    expect(s.players[0]!.score).toBe(97);
  });
  it('a winning Draw Two counts the 2 cards the next player had to draw', () => {
    const last = act('red', 'draw2');
    const base = rig({ hands: { a: [last], b: [num('blue', 1)], c: [num('blue', 2)] }, pile: filler(5) });
    const s = playCard(base, 'a', last.id);
    expect(hand(s, 'b')).toHaveLength(3);
    expect(s.roundPoints).toBe(1 + 9 + 9 + 2);
  });
  it('ends the game when someone reaches the target score (host can lower it)', () => {
    const s = finish({ targetScore: 50 });
    expect(s.phase).toBe('gameOver');
    expect(s.gameWinnerId).toBe('a');
  });
  it('keeps going with a new round when nobody reached the target', () => {
    const over = finish();
    expect(over.gameWinnerId).toBeNull();
    const s = nextUnoRound(over, seeded(7));
    expect(s.phase).toBe('playing');
    expect(s.round).toBe(2);
    expect(s.players[0]!.score).toBe(97);
    expect(s.dealer).toBe(0); // dealer moved on from seat 2
    expect(s.players.every((p) => p.hand.length >= 7)).toBe(true);
    expect(totalCards(s)).toBe(108);
  });
  it('blocks play after the round ends and blocks nextUnoRound mid-round', () => {
    const over = finish();
    throwsUno(() => drawCard(over, 'b'), /round is over/);
    throwsUno(() => skipTurn(over), /round is over/);
    throwsUno(() => callUno(over, 'b'), /round is over/);
    throwsUno(() => nextUnoRound(rig()), /not over/);
    throwsUno(() => nextUnoRound(finish({ targetScore: 50 })), /not over/);
  });
  it('accumulates scores across rounds until the target is hit', () => {
    let s = finish({ targetScore: 150 });
    expect(s.phase).toBe('roundOver');
    s = rigNextRound(s);
    const last = num('red', 9);
    s.players[0]!.hand = [last];
    s.players[1]!.hand = [num('blue', 7), wild()];
    s.players[2]!.hand = [num('blue', 1)];
    s.discard.push(num('red', 5));
    s.activeColor = 'red';
    s.current = 0;
    s.drawn = null;
    s = playCard(s, 'a', last.id);
    expect(s.players[0]!.score).toBe(97 + 58);
    expect(s.phase).toBe('gameOver');
  });
  function rigNextRound(over: UnoState): UnoState {
    return nextUnoRound(over, seeded(3));
  }
});

// ---- privacy ---------------------------------------------------------------

describe('unoViewFor', () => {
  it('shows your own hand and only card counts for everyone else', () => {
    const secret = [num('green', 6), act('yellow', 'skip'), wild()];
    const s = rig({ hands: { a: filler(3), b: secret, c: filler(2) } });
    const view = unoViewFor(s, 'a');
    expect(view.you.hand).toEqual(hand(s, 'a'));
    expect(view.players.find((p) => p.id === 'b')).toEqual({ id: 'b', cardCount: 3, score: 0, uno: false });
    const json = JSON.stringify(view);
    for (const c of secret) expect(json).not.toContain(`"id":${c.id},`);
    expect(Object.keys(view)).not.toContain('drawPile');
    expect(view.drawPileCount).toBe(40);
  });
  it('flags whose turn it is, draw/pass availability and the UNO badge', () => {
    const s = rig({ hands: { a: filler(3), b: [num('blue', 1)], c: filler(3) } });
    expect(unoViewFor(s, 'a').canDraw).toBe(true);
    expect(unoViewFor(s, 'b').canDraw).toBe(false);
    expect(unoViewFor(s, 'a').currentPlayerId).toBe('a');
    expect(unoViewFor(s, 'a').players.find((p) => p.id === 'b')!.uno).toBe(true);
    expect(unoViewFor(s, 'a').canPass).toBe(false);
  });
  it('rejects unknown players', () => {
    throwsUno(() => unoViewFor(rig(), 'nobody'));
  });
});

// ---- whole-game simulation -------------------------------------------------

describe('random bot games', () => {
  /** Plays one full game with bots that make random legal choices. Fails on any thrown rule or lost card. */
  function simulate(seed: number, n: number) {
    const rng = seeded(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
    let s = createUnoGame(Array.from({ length: n }, (_, i) => `p${i}`), { targetScore: 60 }, rng);
    for (let guard = 0; guard < 20000; guard++) {
      expect(totalCards(s)).toBe(108 * deckCountFor(n));
      if (s.phase === 'gameOver') return s;
      if (s.phase === 'roundOver') {
        s = nextUnoRound(s, rng);
        continue;
      }
      // occasionally someone spots a missed UNO
      if (s.unoPending && rng() < 0.5) s = catchUno(s, pick(s.players.filter((p) => p.id !== s.unoPending)).id, rng);
      const me = s.players[s.current]!; // read after the catch: it may have changed hand sizes
      if (me.hand.length <= 2 && rng() < 0.7) s = callUno(s, me.id);
      if (s.phase === 'challenge') {
        s = rng() < 0.5 ? challengeDrawFour(s, me.id, rng) : drawCard(s, me.id, rng);
        continue;
      }
      const plays = legalPlays(s, me.id);
      if (plays.length && rng() < 0.9) {
        const chosen = pick(plays);
        const card = me.hand.find((c) => c.id === chosen)!;
        s = playCard(s, me.id, card.id, card.color === 'wild' ? pick([...UNO_COLORS]) : undefined, rng);
      } else if (s.drawn !== null) {
        s = passTurn(s, me.id);
      } else {
        s = drawCard(s, me.id, rng);
      }
    }
    throw new Error(`game ${seed} (${n} players) did not finish`);
  }

  it('finishes with a winner, never losing or duplicating a card, for 2-20 players', () => {
    for (let seed = 1; seed <= 57; seed++) {
      const n = 2 + (seed % 19);
      const end = simulate(seed, n);
      expect(end.gameWinnerId).not.toBeNull();
      expect(end.players.find((p) => p.id === end.gameWinnerId)!.score).toBeGreaterThanOrEqual(60);
    }
  });
});
