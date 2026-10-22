/**
 * Load test: N phones join, sign in, connect and watch the lobby; the host broadcasts; `seats` of them play a
 * full UNO game as bots (draw, play, UNO, catch, Draw Four challenges...) while the rest spectate; mid-game the
 * server is killed and restarted and everyone must come back to the exact same table.
 *
 * It only talks to the server over HTTP and sockets, exactly like phones, so the same code drives the automated
 * test (in-process server) and `npm run loadtest` (a separate real server process).
 */
import { performance } from 'node:perf_hooks';
import { io, type Socket } from 'socket.io-client';
import type {
  AdminResult,
  AdminState,
  ClientToServerEvents,
  PlayerPublic,
  ServerToClientEvents,
  UnoColor,
  UnoPayload,
} from '@party/shared';

type Sock = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface ServerCtl {
  url: string;
  adminPassword: string;
  /** Kill the server abruptly and bring it back on the same address with the same database. */
  restart(): Promise<void>;
  /** Resident memory of the server process in MB, when we can read it. */
  rssMb?(): Promise<number | null>;
}

export interface LoadOptions {
  players: number;
  seats: number;
  targetScore: number;
  /** Kill and restart the server after this many UNO moves (null = never). */
  restartAfterMoves: number | null;
  /** Pause before a bot acts, like a thinking human. 0 = hammer the server. */
  thinkMs: number;
  announcements: number;
  timeoutMs: number;
  log: (line: string) => void;
}

export interface Stat {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LoadReport {
  ok: boolean;
  failures: string[];
  players: number;
  seats: number;
  moves: number;
  rounds: number;
  durationS: number;
  restartRecoveryMs: number | null;
  serverRssMb: number | null;
  /** Average size of one `uno:state` push, in KB (what each seated phone downloads per update). */
  avgUnoPushKb: number;
  stats: Record<string, Stat>;
  errorsSeen: Record<string, number>;
}

// ---- small helpers ---------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

function stat(samples: number[]): Stat {
  if (samples.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s[s.length - 1]!) };
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function post(base: string, path: string, body: object) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { status: res.status, cookie, json: (await res.json()) as any };
}

/** Failures that are normal races between bots, not bugs (two bots catching the same player, a late UNO press). */
const BENIGN = [/nobody to catch/i, /round is over/i, /one or two cards/i];

// ---- shared state ----------------------------------------------------------

interface Shared {
  moves: number;
  errors: Record<string, number>;
  ack: number[];
  handoff: number[];
  lastMoveAt: number;
  unoPushBytes: number;
  unoPushes: number;
  paused: boolean;
  thinkMs: number;
  failures: string[];
}

class Bot {
  socket!: Sock;
  cookie = '';
  playerId = 0;
  last: UnoPayload | null | undefined;
  lobby: PlayerPublic[] = [];
  syncs = 0;
  announced: string[] = [];
  lastUnoPushAt = 0;
  private lastSig = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** One action at a time per phone, like a person: a push that arrives mid-move is handled afterwards. */
  private acting = false;
  private dirty = false;

  constructor(public readonly name: string, public readonly phone: string, public readonly pin: string | undefined, private sh: Shared, private url: string) {}

  async join(): Promise<number> {
    const t0 = now();
    const first = await post(this.url, '/api/join', { phone: this.phone, name: this.name, ...(this.pin ? { pin: this.pin } : {}) });
    if (!first.cookie) throw new Error(`${this.name} could not join: ${JSON.stringify(first.json)}`);
    this.cookie = first.cookie;
    this.playerId = first.json.me.id;
    return now() - t0;
  }

  /** Opens the socket (auto-reconnecting, like a phone) and resolves with how long the first `sync` took. */
  connect(): Promise<number> {
    const t0 = now();
    return new Promise((resolve, reject) => {
      this.socket = io(this.url, {
        transports: ['websocket'],
        extraHeaders: { cookie: this.cookie },
        reconnection: true,
        reconnectionDelay: 100,
        reconnectionDelayMax: 500,
      });
      this.socket.on('sync', (s) => {
        this.syncs++;
        this.last = s.uno;
        this.lobby = s.players;
        if (this.syncs === 1) resolve(now() - t0);
        this.consider();
      });
      this.socket.on('lobby:update', (p) => (this.lobby = p));
      this.socket.on('announce', (a) => this.announced.push(a.id));
      this.socket.on('uno:state', (p) => {
        this.last = p;
        if (p) {
          this.sh.unoPushBytes += JSON.stringify(p).length;
          this.sh.unoPushes++;
        }
        this.lastUnoPushAt = now();
        this.consider();
      });
      this.socket.once('connect_error', (e) => reject(e));
    });
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }

  resume() {
    this.sh.lastMoveAt = 0; // don't count the pause as turn-handoff time
    this.lastSig = ''; // re-evaluate the table from scratch
    this.consider();
  }

  private sig(): string {
    const v = this.last!.view;
    return [v.round, v.phase, v.currentPlayerId, v.you.hand.length, v.drawPileCount, v.top.id, v.canPass, v.challenge?.targetId, v.catchable].join('|');
  }

  private isMyTurn(): boolean {
    const v = this.last?.view;
    if (!v) return false;
    return (v.phase === 'playing' && v.currentPlayerId === v.you.id) || (v.phase === 'challenge' && v.challenge?.targetId === v.you.id);
  }

  /** Called on every new table state: decide whether something needs doing, once per distinct state. */
  private consider() {
    if (this.sh.paused || !this.last?.view) return;
    if (this.acting) {
      this.dirty = true;
      return;
    }
    const s = this.sig();
    if (s === this.lastSig) return;
    this.lastSig = s;
    if (this.isMyTurn() && this.sh.lastMoveAt) {
      this.sh.handoff.push(now() - this.sh.lastMoveAt);
      this.sh.lastMoveAt = 0;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.act(), this.sh.thinkMs);
  }

  private async send(event: string, payload?: object): Promise<AdminResult> {
    const t0 = now();
    this.sh.lastMoveAt = t0;
    const r = await new Promise<AdminResult>((resolve) => {
      const emit = this.socket.emit.bind(this.socket) as (...a: unknown[]) => void;
      const timer = setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 8000);
      const done = (res: AdminResult) => {
        clearTimeout(timer);
        resolve(res);
      };
      payload ? emit(event, payload, done) : emit(event, done);
    });
    this.sh.ack.push(now() - t0);
    if (r.ok) this.sh.moves++;
    else {
      this.sh.errors[r.error] = (this.sh.errors[r.error] ?? 0) + 1;
      if (!BENIGN.some((b) => b.test(r.error))) this.sh.failures.push(`${this.name}: ${event} refused: ${r.error}`);
    }
    return r;
  }

  private async act() {
    this.acting = true;
    try {
      await this.actOnce();
    } finally {
      this.acting = false;
      if (this.dirty) {
        this.dirty = false;
        this.consider();
      }
    }
  }

  private async actOnce() {
    if (this.sh.paused || !this.last?.view) return;

    // Sharp-eyed players catch a forgotten UNO.
    if (this.last.view.catchable && this.last.view.catchable !== this.last.view.you.id && Math.random() < 0.6) {
      await this.send('uno:catch');
    }
    if (!this.isMyTurn() || this.sh.paused) return;

    if (this.last!.view.phase === 'challenge') {
      await this.send(Math.random() < 0.5 ? 'uno:challenge' : 'uno:draw');
      return;
    }
    if (this.last!.view.you.hand.length <= 2 && !this.last!.view.you.calledUno && Math.random() < 0.7) {
      await this.send('uno:callUno');
      if (!this.isMyTurn()) return; // re-read: the table may have moved while we waited
    }

    const v = this.last!.view;
    const playable = v.playable;
    const wantPlay = v.canPass ? Math.random() < 0.75 : playable.length > 0 && Math.random() < 0.9;
    if (wantPlay && playable.length) {
      const id = playable[Math.floor(Math.random() * playable.length)]!;
      const card = v.you.hand.find((c) => c.id === id)!;
      await this.send('uno:play', { cardId: id, ...(card.color === 'wild' ? { color: this.bestColor() } : {}) });
    } else if (v.canPass) {
      await this.send('uno:pass');
    } else {
      await this.send('uno:draw');
    }
  }

  private bestColor(): UnoColor {
    const counts: Record<string, number> = {};
    for (const c of this.last!.view.you.hand) if (c.color !== 'wild') counts[c.color] = (counts[c.color] ?? 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return (best?.[0] as UnoColor) ?? 'red';
  }
}

// ---- the test --------------------------------------------------------------

export async function runLoadTest(ctl: ServerCtl, o: LoadOptions): Promise<LoadReport> {
  const started = Date.now();
  const sh: Shared = {
    moves: 0, errors: {}, ack: [], handoff: [], lastMoveAt: 0, unoPushBytes: 0, unoPushes: 0, paused: false, thinkMs: o.thinkMs, failures: [],
  };
  const failures = sh.failures;
  const fail = (m: string) => failures.push(m);
  const stats: Record<string, Stat> = {};
  let rounds = 0;
  let restartRecoveryMs: number | null = null;

  // phones: every other player has a PIN, so we also feel the cost of hashing them
  const run = String(Date.now()).slice(-6);
  const bots = Array.from({ length: o.players }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return new Bot(`Load${n}`, `077${run}${n}`, i % 2 === 0 ? String(1000 + i) : undefined, sh, ctl.url);
  });

  let admin: Sock | null = null;
  let adminState: AdminState | null = null;
  const adminConnect = async () => {
    const login = await post(ctl.url, '/api/admin/login', { password: ctl.adminPassword });
    if (!login.cookie) throw new Error(`Admin login failed (${login.status}): ${JSON.stringify(login.json)}`);
    admin?.close();
    admin = io(ctl.url, { transports: ['websocket'], extraHeaders: { cookie: login.cookie }, reconnection: false });
    admin.on('admin:state', (s) => (adminState = s));
    await waitFor(() => adminState !== null, 5000, 'admin state');
  };
  const adminSend = (event: string, payload?: object) =>
    new Promise<AdminResult>((resolve) => {
      const emit = admin!.emit.bind(admin) as (...a: unknown[]) => void;
      payload ? emit(event, payload, resolve) : emit(event, resolve);
    });

  try {
    // 1. everyone signs in at the same moment
    o.log(`Joining ${o.players} players at once (${bots.filter((b) => b.pin).length} with a PIN)...`);
    const joinTimes = await Promise.all(bots.map((b) => b.join()));
    stats['join (HTTP)'] = stat(joinTimes);
    stats['join with PIN'] = stat(joinTimes.filter((_, i) => bots[i]!.pin));
    stats['join no PIN'] = stat(joinTimes.filter((_, i) => !bots[i]!.pin));

    // 2. all sockets connect at once and receive a full sync
    o.log('Connecting sockets...');
    stats['socket connect + sync'] = stat(await Promise.all(bots.map((b) => b.connect())));
    try {
      await waitFor(() => bots.every((b) => b.lobby.filter((p) => p.online).length === o.players), 8000, 'everyone to see everyone online');
    } catch {
      fail(`Lobby never showed all ${o.players} players online on every phone`);
    }

    // 3. the host connects and sees all of them
    await adminConnect();
    if (adminState!.players.length < o.players) fail(`Admin sees ${adminState!.players.length} players, expected ${o.players}`);

    // 4. announcements reach every phone
    o.log(`Broadcasting ${o.announcements} announcements...`);
    const fan: number[] = [];
    for (let i = 0; i < o.announcements; i++) {
      const before = bots.map((b) => b.announced.length);
      const t0 = now();
      await adminSend('admin:broadcast', { text: `Load announcement ${i + 1}` });
      try {
        await waitFor(() => bots.every((b, k) => b.announced.length > before[k]!), 5000, 'an announcement on every phone');
        fan.push(now() - t0);
      } catch {
        fail(`Announcement ${i + 1} did not reach every phone`);
      }
    }
    stats['announce reaches all phones'] = stat(fan);

    // 5. seat the first N and deal
    const seated = bots.slice(0, o.seats);
    const spectators = bots.slice(o.seats);
    o.log(`Dealing UNO to ${o.seats} players; ${spectators.length} spectate...`);
    const dealt = await adminSend('admin:unoCreate', { playerIds: seated.map((b) => b.playerId), targetScore: o.targetScore });
    if (!dealt.ok) throw new Error(`Could not deal: ${dealt.error}`);
    await waitFor(() => seated.every((b) => b.last?.view), 5000, 'seated players to receive their hands');
    if (spectators.some((b) => b.last)) fail('A spectator received a UNO table');

    // 6. play to the end, restarting the server once along the way
    const privacyCheck = () => {
      const full = adminState?.uno?.state;
      if (!full) return fail('Admin has no table state to check privacy against');
      for (const b of seated) {
        const own = new Set(full.players.find((p) => p.id === String(b.playerId))!.hand.map((c) => c.id));
        const foreign = full.players.filter((p) => p.id !== String(b.playerId)).flatMap((p) => p.hand.map((c) => c.id)).filter((id) => !own.has(id));
        const json = JSON.stringify(b.last);
        if (foreign.some((id) => json.includes(`"id":${id},"color"`))) fail(`${b.name}'s phone received another player's cards`);
        if (b.last!.view.you.hand.length !== full.players.find((p) => p.id === String(b.playerId))!.hand.length) fail(`${b.name}'s hand disagrees with the server`);
      }
    };

    let restarted = o.restartAfterMoves === null;
    let lastMoves = -1;
    let lastProgress = Date.now();
    const gameStart = Date.now();
    o.log('Playing...');
    while (true) {
      if (failures.length > 0 && failures.some((f) => !f.startsWith('Announcement'))) break;
      const view = seated[0]!.last?.view;
      if (view?.phase === 'gameOver') break;
      if (view?.phase === 'roundOver') {
        rounds++;
        o.log(`  round ${view.round} over after ${sh.moves} moves; dealing the next`);
        const r = await adminSend('admin:unoNextRound');
        if (!r.ok) fail(`Deal next round refused: ${r.error}`);
        await waitFor(() => seated[0]!.last?.view.phase === 'playing' && seated[0]!.last!.view.round === view.round + 1, 5000, 'the next round');
        continue;
      }

      if (!restarted && sh.moves >= o.restartAfterMoves!) {
        restarted = true;
        o.log(`Restarting the server mid-game after ${sh.moves} moves...`);
        sh.paused = true;
        // let in-flight updates land so the snapshot is exact
        let quiet = false;
        while (!quiet) {
          const t = now();
          await sleep(350);
          quiet = bots.every((b) => b.lastUnoPushAt < t) && admin !== null;
        }
        adminState = null;
        await adminConnect(); // fresh state straight from the server
        privacyCheck();
        const before = {
          current: seated[0]!.last!.view.currentPlayerId,
          top: seated[0]!.last!.view.top.id,
          hands: Object.fromEntries(seated.map((b) => [b.name, b.last!.view.you.hand.map((c) => c.id).join(',')])),
        };
        const syncsBefore = bots.map((b) => b.syncs);
        await ctl.restart();
        const t0 = now();
        try {
          await waitFor(() => bots.every((b, i) => b.syncs > syncsBefore[i]!), 20000, 'every phone to reconnect after the restart');
          restartRecoveryMs = now() - t0;
        } catch (e) {
          fail((e as Error).message);
          break;
        }
        const v = seated[0]!.last!.view;
        if (v.currentPlayerId !== before.current) fail('After the restart the turn moved to someone else');
        if (v.top.id !== before.top) fail('After the restart the top card changed');
        for (const b of seated) {
          if (b.last!.view.you.hand.map((c) => c.id).join(',') !== before.hands[b.name]) fail(`${b.name}'s hand changed across the restart`);
        }
        if (spectators.some((b) => b.last)) fail('A spectator received a UNO table after the restart');
        await adminConnect(); // the host signs in again (admin sessions live in memory)
        sh.paused = false;
        bots.forEach((b) => b.resume());
        lastProgress = Date.now();
      }

      if (sh.moves !== lastMoves) {
        lastMoves = sh.moves;
        lastProgress = Date.now();
      } else if (Date.now() - lastProgress > 10000) {
        fail(`The game stalled: no move for 10 s (phase ${view?.phase}, turn ${view?.currentPlayerId})`);
        break;
      }
      if (Date.now() - gameStart > o.timeoutMs) {
        fail(`The game did not finish within ${Math.round(o.timeoutMs / 1000)} s`);
        break;
      }
      await sleep(20);
    }

    const end = seated[0]!.last?.view;
    if (end?.phase === 'gameOver') {
      rounds++;
      const winner = end.players.find((p) => p.id === end.gameWinnerId);
      if (!winner || winner.score < o.targetScore) fail('Game over without a winner at the target score');
      o.log(`Game over: ${rounds} round(s), ${sh.moves} moves.`);
    }
    await sleep(100);
    if ((adminState as AdminState | null)?.uno) privacyCheck();
  } catch (e) {
    fail((e as Error).message);
  }

  stats['UNO move ack'] = stat(sh.ack);
  stats['turn handoff (move to next phone)'] = stat(sh.handoff);
  const serverRssMb = (await ctl.rssMb?.().catch(() => null)) ?? null;
  const errorsSeen = sh.errors;
  bots.forEach((b) => b.close());
  (admin as Sock | null)?.close();

  return {
    ok: failures.length === 0,
    failures,
    players: o.players,
    seats: o.seats,
    moves: sh.moves,
    rounds,
    durationS: Math.round((Date.now() - started) / 100) / 10,
    restartRecoveryMs: restartRecoveryMs === null ? null : Math.round(restartRecoveryMs),
    serverRssMb,
    avgUnoPushKb: sh.unoPushes ? Math.round((sh.unoPushBytes / sh.unoPushes / 1024) * 10) / 10 : 0,
    stats,
    errorsSeen,
  };
}

/** Human-readable summary for the terminal and the docs. */
export function formatReport(r: LoadReport): string {
  const lines = [
    `${r.ok ? 'PASS' : 'FAIL'}: ${r.players} players, ${r.seats} at the UNO table, ${r.moves} moves, ${r.rounds} round(s), ${r.durationS}s`,
    '',
    'Latency (ms)                              n    p50    p95    max',
    ...Object.entries(r.stats).map(([k, s]) => `  ${k.padEnd(36)}${String(s.n).padStart(4)}${String(s.p50).padStart(7)}${String(s.p95).padStart(7)}${String(s.max).padStart(7)}`),
    '',
    `Restart mid-game: ${r.restartRecoveryMs === null ? 'not run' : `all ${r.players} phones back and in sync after ${r.restartRecoveryMs} ms`}`,
    `Server memory: ${r.serverRssMb === null ? 'n/a' : `${r.serverRssMb} MB`}`,
    `Average UNO update: ${r.avgUnoPushKb} KB per push to a seated phone`,
  ];
  const errs = Object.entries(r.errorsSeen);
  if (errs.length) lines.push('', 'Refused moves (benign races are expected):', ...errs.map(([m, n]) => `  ${n}x ${m}`));
  if (r.failures.length) lines.push('', 'Failures:', ...[...new Set(r.failures)].slice(0, 15).map((f) => `  - ${f}`));
  return lines.join('\n');
}
