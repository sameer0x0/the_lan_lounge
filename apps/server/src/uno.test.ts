import { afterEach, describe, expect, it } from 'vitest';
import {
  createUnoGame,
  type AdminResult,
  type CardKind,
  type UnoCard,
  type UnoColor,
  type UnoPayload,
  type UnoState,
} from '@party/shared';
import { once, startServer, type Client } from './helpers.test-util.js';

let t: Awaited<ReturnType<typeof startServer>>;
afterEach(() => t.stop());

// ---- helpers ---------------------------------------------------------------

let nextId = 1000;
const card = (color: UnoCard['color'], kind: CardKind, value: number | null = null): UnoCard => ({ id: nextId++, color, kind, value });
const num = (color: UnoColor, v: number) => card(color, 'number', v);
const filler = (n: number) => Array.from({ length: n }, () => num('blue', 9));

/** Latest UNO payload each socket was sent. */
function watch(s: Client) {
  const w = { last: undefined as UnoPayload | null | undefined, all: [] as (UnoPayload | null)[] };
  s.on('uno:state', (p) => {
    w.last = p;
    w.all.push(p);
  });
  return w;
}
async function until(check: () => boolean, ms = 1500) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for a socket update');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const ack = (s: Client, event: string, ...args: unknown[]) => new Promise<AdminResult>((r) => (s as any).emit(event, ...args, r));

/** Players 1-3 are seated; player 4 is online but not seated. Ids are 1..4 because the DB is fresh. */
async function setup(opts: { seat?: boolean } = {}) {
  t = await startServer({ adminPassword: 'pw' });
  const names = ['Ann', 'Ben', 'Cat', 'Dan'];
  const joins = [];
  for (let i = 0; i < 4; i++) joins.push(await t.join({ phone: `0770090012${i}`, name: names[i] }));
  const cookies = joins.map((j) => j.cookie!);
  const socks = cookies.map((c) => t.open(c));
  await Promise.all(socks.map((s) => once(s, 'sync')));
  const [a, b, c, d] = socks as [Client, Client, Client, Client];
  const watchers = socks.map(watch);
  const admin = t.open((await t.post('/api/admin/login', { password: 'pw' })).cookie!);
  await once(admin, 'admin:state');
  if (opts.seat !== false) {
    expect(await ack(admin, 'admin:unoCreate', { playerIds: [1, 2, 3] })).toEqual({ ok: true });
    await until(() => watchers.slice(0, 3).every((w) => w.last?.view));
  }
  return { a, b, c, d, admin, wa: watchers[0]!, wb: watchers[1]!, wc: watchers[2]!, wd: watchers[3]!, cookies };
}

/** Id of the top card of the most recent rigged table: waiting for it proves the rig reached the phones
 *  (waiting on a card value would race the randomly dealt game, which can open on the same value). */
let riggedTop = -1;

/** Replace the live table with a rigged one (seat 0 = player 1 to act, top red 5, 3 filler cards each). */
function rigTable(o: { hands?: Record<string, UnoCard[]>; top?: UnoCard; current?: number; pile?: UnoCard[]; targetScore?: number } = {}) {
  const s: UnoState = JSON.parse(JSON.stringify(createUnoGame(['1', '2', '3'], { targetScore: o.targetScore })));
  s.phase = 'playing';
  s.current = o.current ?? 0;
  s.direction = 1;
  s.drawn = null;
  s.challenge = null;
  s.unoPending = null;
  s.log = [];
  const top = o.top ?? num('red', 5);
  riggedTop = top.id;
  s.discard = [top];
  s.activeColor = top.color === 'wild' ? null : top.color;
  s.drawPile = o.pile ?? filler(40);
  for (const p of s.players) p.hand = o.hands?.[p.id] ?? filler(3);
  t.uno.table!.state = s;
  t.unoChanged(null, s);
  return s;
}

// ---- tests -----------------------------------------------------------------

describe('seating and privacy', () => {
  it('seated players get their own table; the unseated get nothing', async () => {
    const { wa, wb, wc, wd, admin } = await setup();
    for (const [w, id] of [[wa, '1'], [wb, '2'], [wc, '3']] as const) {
      expect(w.last!.view.you.id).toBe(id);
      expect(w.last!.view.you.hand.length).toBeGreaterThanOrEqual(7);
      expect(w.last!.seats.map((s) => s.name)).toEqual(['Ann', 'Ben', 'Cat']);
    }
    expect(wd.last ?? null).toBeNull();
    expect(await ack(admin, 'admin:unoEnd')).toEqual({ ok: true });
  });

  it("never sends another player's cards to a phone, but does to the admin (god mode)", async () => {
    const { wa, admin } = await setup();
    const state = t.uno.table!.state;
    const benCards = state.players[1]!.hand;
    const ownIds = new Set(state.players[0]!.hand.map((c) => c.id));
    const seen = JSON.stringify(wa.all);
    for (const c of benCards) if (!ownIds.has(c.id)) expect(seen).not.toContain(`"id":${c.id},"color"`);
    expect(JSON.stringify(wa.last)).not.toContain('drawPile"');

    const adminState = await new Promise<any>((r) => { admin.once('admin:state', r); t.broadcastLobby(); });
    expect(adminState.uno.state.players[1].hand).toHaveLength(benCards.length);
  });

  it('a reconnecting seated player is handed their table again in sync', async () => {
    const { a, wa, cookies } = await setup();
    const hand = wa.last!.view.you.hand;
    a.close();
    const again = t.open(cookies[0]);
    const sync = await once<any>(again, 'sync');
    expect(sync.uno.view.you.hand).toEqual(hand);
    expect(sync.uno.view.currentPlayerId).toBe(wa.last!.view.currentPlayerId);
  });

  it('survives a server restart mid-game', async () => {
    const { a, wa, cookies } = await setup();
    rigTable({ hands: { '1': [num('red', 9), num('blue', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    const card = wa.last!.view.you.hand[0]!;
    expect(await ack(a, 'uno:play', { cardId: card.id })).toEqual({ ok: true });

    const db = t.db;
    await t.stop();
    t = await startServer({ db, adminPassword: 'pw' });
    const back = t.open(cookies[1]);
    const sync = await once<any>(back, 'sync');
    expect(sync.uno.view.top.id).toBe(card.id);
    expect(sync.uno.view.currentPlayerId).toBe('2');
    expect(sync.uno.view.players.find((p: any) => p.id === '1').cardCount).toBe(1);
  });

  it('saves every move to the games table', async () => {
    const { a, wa } = await setup();
    rigTable({ hands: { '1': [num('red', 9), num('blue', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    await ack(a, 'uno:play', { cardId: wa.last!.view.you.hand[0]!.id });
    const row = t.db.$client.prepare("select status, state_json from games where type = 'uno'").get() as any;
    expect(row.status).toBe('playing');
    expect(JSON.parse(row.state_json)).toEqual(JSON.parse(JSON.stringify(t.uno.table!.state)));
  });
});

describe('moves', () => {
  it('a legal play moves the turn on for everyone', async () => {
    const { a, wa, wb, wc } = await setup();
    rigTable({ hands: { '1': [num('red', 9), num('blue', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    const nine = wa.last!.view.you.hand[0]!;
    expect(wa.last!.view.playable).toContain(nine.id);
    expect(await ack(a, 'uno:play', { cardId: nine.id })).toEqual({ ok: true });
    await until(() => [wa, wb, wc].every((w) => w.last!.view.currentPlayerId === '2'));
    for (const w of [wa, wb, wc]) {
      expect(w.last!.view.top.id).toBe(nine.id);
      expect(w.last!.view.players.find((p) => p.id === '1')!.cardCount).toBe(1);
    }
  });

  it('refuses out-of-turn, illegal, missing, malformed and unseated moves with a reason', async () => {
    const { a, b, d, wa } = await setup();
    rigTable({ hands: { '1': [num('red', 9), num('green', 2)], '2': [num('red', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    const [nine, two] = wa.last!.view.you.hand as [UnoCard, UnoCard];
    expect(await ack(b, 'uno:play', { cardId: 5 })).toMatchObject({ ok: false, error: expect.stringMatching(/not your turn/i) });
    expect(await ack(a, 'uno:play', { cardId: two.id })).toMatchObject({ ok: false, error: expect.stringMatching(/match/i) });
    expect(await ack(a, 'uno:play', { cardId: 99999 })).toMatchObject({ ok: false, error: expect.stringMatching(/do not have/i) });
    expect(await ack(a, 'uno:play', { cardId: 'x' })).toMatchObject({ ok: false });
    expect(await ack(a, 'uno:play', { cardId: nine.id, color: 'purple' })).toMatchObject({ ok: false });
    expect(await ack(d, 'uno:draw')).toMatchObject({ ok: false, error: expect.stringMatching(/not in this game/i) });
    expect(t.uno.table!.state.current).toBe(0); // nothing above changed the game
  });

  it('says so when there is no game', async () => {
    const { a } = await setup({ seat: false });
    expect(await ack(a, 'uno:draw')).toEqual({ ok: false, error: 'No UNO game is running' });
  });

  it('drawing: an unplayable card ends the turn, a playable one can be passed', async () => {
    const { a, b, wa, wb } = await setup();
    rigTable({ pile: [num('blue', 9), num('blue', 9)] });
    await until(() => wa.last?.view.top.id === riggedTop);
    expect(wa.last!.view.canDraw).toBe(true);
    expect(await ack(a, 'uno:draw')).toEqual({ ok: true });
    await until(() => wb.last!.view.currentPlayerId === '2');
    expect(wa.last!.view.you.hand).toHaveLength(4);

    const red7 = num('red', 7);
    rigTable({ current: 1, pile: [red7] });
    await until(() => wb.last!.view.currentPlayerId === '2' && wb.last!.view.drawPileCount === 1);
    expect(await ack(b, 'uno:draw')).toEqual({ ok: true });
    await until(() => wb.last!.view.canPass);
    expect(wb.last!.view.playable).toEqual([red7.id]);
    expect(await ack(b, 'uno:pass')).toEqual({ ok: true });
    await until(() => wb.last!.view.currentPlayerId === '3');
  });

  it('wilds need a colour; the chosen colour is announced', async () => {
    const { a, wb, wa } = await setup();
    const wild = card('wild', 'wild');
    rigTable({ hands: { '1': [wild, num('blue', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    expect(await ack(a, 'uno:play', { cardId: wild.id })).toMatchObject({ ok: false, error: expect.stringMatching(/colour/i) });
    expect(await ack(a, 'uno:play', { cardId: wild.id, color: 'green' })).toEqual({ ok: true });
    await until(() => wb.last!.view.activeColor === 'green');
  });

  it('UNO / Catch: forgetting UNO lets another player catch you for 2 cards', async () => {
    const { a, c, wa, wc } = await setup();
    rigTable({ hands: { '1': [num('red', 9), num('blue', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    await ack(a, 'uno:play', { cardId: wa.last!.view.you.hand[0]!.id });
    await until(() => wc.last!.view.catchable === '1');
    expect(await ack(a, 'uno:catch')).toMatchObject({ ok: false }); // can't catch yourself
    expect(await ack(c, 'uno:catch')).toEqual({ ok: true });
    await until(() => wa.last!.view.you.hand.length === 3);
    expect(wc.last!.view.catchable).toBeNull();
  });

  it('UNO / Catch: calling UNO in time protects you', async () => {
    const { a, c, wa, wc } = await setup();
    rigTable({ hands: { '1': [num('red', 9), num('blue', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    expect(await ack(a, 'uno:callUno')).toEqual({ ok: true });
    await ack(a, 'uno:play', { cardId: wa.last!.view.you.hand[0]!.id });
    await until(() => wc.last!.view.players.find((p) => p.id === '1')!.cardCount === 1);
    expect(wc.last!.view.catchable).toBeNull();
    expect(await ack(c, 'uno:catch')).toMatchObject({ ok: false });
  });

  it('Wild Draw Four: the target can challenge a bluff, and the bluffer takes 4', async () => {
    const { a, b, wa, wb } = await setup();
    const w4 = card('wild', 'wild4');
    rigTable({ hands: { '1': [w4, num('red', 1), num('blue', 1)] } }); // holds red on red: a bluff
    await until(() => wa.last?.view.top.id === riggedTop);
    expect(await ack(a, 'uno:play', { cardId: w4.id, color: 'blue' })).toEqual({ ok: true });
    await until(() => wb.last!.view.challenge?.targetId === '2');
    expect(wb.last!.view.canDraw).toBe(true);
    expect(JSON.stringify(wb.last)).not.toMatch(/bluff/i);
    expect(await ack(a, 'uno:challenge')).toMatchObject({ ok: false });
    expect(await ack(b, 'uno:challenge')).toEqual({ ok: true });
    await until(() => wa.last!.view.you.hand.length === 6);
    expect(wb.last!.view.you.hand).toHaveLength(3);
    expect(wb.last!.view.currentPlayerId).toBe('2');
  });

  it('Wild Draw Four: accepting means drawing 4 and losing the turn', async () => {
    const { a, b, wa, wb } = await setup();
    const w4 = card('wild', 'wild4');
    rigTable({ hands: { '1': [w4, num('blue', 1)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    await ack(a, 'uno:play', { cardId: w4.id, color: 'green' });
    await until(() => wb.last!.view.challenge !== null);
    expect(await ack(b, 'uno:draw')).toEqual({ ok: true });
    await until(() => wb.last!.view.you.hand.length === 7);
    expect(wb.last!.view.currentPlayerId).toBe('3');
  });

  it('finishing a round shows the score to everyone, and the host deals the next one', async () => {
    const { a, admin, wa, wb } = await setup();
    rigTable({ hands: { '1': [num('red', 9)], '2': [num('blue', 7)], '3': [card('wild', 'wild')] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    await ack(a, 'uno:play', { cardId: wa.last!.view.you.hand[0]!.id });
    await until(() => wb.last!.view.phase === 'roundOver');
    expect(wb.last!.view.roundWinnerId).toBe('1');
    expect(wb.last!.view.roundPoints).toBe(57);
    expect(wb.last!.view.players.find((p) => p.id === '1')!.score).toBe(57);
    (a as any).emit('admin:unoNextRound', () => {}); // a player can't deal; the server ignores it (no ack, by design)
    await new Promise((r) => setTimeout(r, 100));
    expect(t.uno.table!.state.phase).toBe('roundOver');
    expect(await ack(admin, 'admin:unoNextRound')).toEqual({ ok: true });
    await until(() => wb.last!.view.phase === 'playing' && wb.last!.view.round === 2);
    expect(wb.last!.view.players.find((p) => p.id === '1')!.score).toBe(57); // kept
  });
});

describe('host controls', () => {
  it('can skip a stuck turn and end the table', async () => {
    const { admin, wa, wb, wd } = await setup();
    const first = wa.last!.view.currentPlayerId; // a dealt opening Skip/Draw Two can change who starts
    expect(await ack(admin, 'admin:unoSkip')).toEqual({ ok: true });
    await until(() => wb.last!.view.currentPlayerId !== first);
    expect(await ack(admin, 'admin:unoEnd')).toEqual({ ok: true });
    await until(() => wa.last === null && wb.last === null);
    expect(wd.last ?? null).toBeNull();
    expect(await ack(admin, 'admin:unoEnd')).toMatchObject({ ok: false });
    expect(t.db.$client.prepare("select status from games").get()).toEqual({ status: 'ended' });
  });

  it('validates who gets seated', async () => {
    const { admin } = await setup({ seat: false });
    expect(await ack(admin, 'admin:unoCreate', { playerIds: [1] })).toMatchObject({ ok: false });
    expect(await ack(admin, 'admin:unoCreate', { playerIds: [1, 1] })).toMatchObject({ ok: false });
    expect(await ack(admin, 'admin:unoCreate', { playerIds: [1, 99] })).toMatchObject({ ok: false });
    expect(await ack(admin, 'admin:unoCreate', { playerIds: [1, 2], targetScore: -5 })).toMatchObject({ ok: false });
    expect(await ack(admin, 'admin:ban', { playerId: 2, banned: true })).toEqual({ ok: true });
    expect(await ack(admin, 'admin:unoCreate', { playerIds: [1, 2] })).toMatchObject({ ok: false });
    expect(await ack(admin, 'admin:unoCreate', { playerIds: [1, 3], targetScore: 100 })).toEqual({ ok: true });
    expect(t.uno.table!.state.settings.targetScore).toBe(100);
  });

  it('a normal player cannot create a table, and it is logged', async () => {
    const { a } = await setup({ seat: false });
    (a as any).emit('admin:unoCreate', { playerIds: [1, 2, 3] }, () => {});
    await new Promise((r) => setTimeout(r, 150));
    expect(t.uno.table).toBeNull();
    const row = t.db.$client.prepare("select payload_json from audit_log where action = 'admin_rejected'").get() as any;
    expect(row.payload_json).toContain('admin:unoCreate');
  });

  it('records table events in the audit log', async () => {
    const { a, admin, wa } = await setup();
    rigTable({ hands: { '1': [num('red', 9)] } });
    await until(() => wa.last?.view.top.id === riggedTop);
    await ack(a, 'uno:play', { cardId: wa.last!.view.you.hand[0]!.id });
    await ack(admin, 'admin:unoSkip');
    const actions = (t.db.$client.prepare('select action from audit_log order by id').all() as any[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['uno_create', 'uno_round_over']));
  });
});
