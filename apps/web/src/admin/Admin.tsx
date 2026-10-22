import { useEffect, useState, type FormEvent } from 'react';
import { ANNOUNCE_MAX, DEFAULT_TARGET_SCORE, MAX_PLAYERS, MIN_PLAYERS, type AdminPlayer, type AdminResult, type AdminState, type AuditEntry } from '@party/shared';
import { adminApi } from '../api';
import { Card } from '../uno/Card';
import { describeEvent } from '../uno/log';
import { Tv } from './Tv';
import { useAdmin } from './useAdmin';

type Tab = 'players' | 'uno' | 'broadcast' | 'audit' | 'system';

const TABS: { id: Tab; label: string }[] = [
  { id: 'players', label: 'Players' },
  { id: 'uno', label: 'UNO' },
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'audit', label: 'Audit log' },
  { id: 'system', label: 'System' },
];

export function Admin() {
  // undefined = checking
  const [authed, setAuthed] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    adminApi.me().then(setAuthed);
  }, []);

  if (authed === undefined) return <p className="p-8 text-zinc-400">Loading...</p>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Console onSignedOut={() => setAuthed(false)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await adminApi.login(password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-3xl font-extrabold">Party Night admin</h1>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="password"
          autoFocus
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-xl bg-zinc-800 p-3 text-lg outline-none focus:ring-2 focus:ring-emerald-500"
        />
        {error && <p className="text-red-300">{error}</p>}
        <button className="rounded-xl bg-emerald-600 p-3 text-lg font-bold">Sign in</button>
      </form>
    </main>
  );
}

function Console({ onSignedOut }: { onSignedOut: () => void }) {
  const { state, connected, send } = useAdmin(onSignedOut);
  const [tab, setTab] = useState<Tab>('players');
  const [toast, setToast] = useState('');

  if (window.location.pathname.startsWith('/admin/tv')) return <Tv state={state} />;

  /** Runs a command and surfaces failures; successes show up through the pushed state. */
  const run = async (p: Promise<AdminResult>, okMessage?: string) => {
    const r = await p;
    setToast(r.ok ? (okMessage ?? '') : r.error);
    setTimeout(() => setToast(''), 3000);
    return r;
  };

  return (
    <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-3xl font-extrabold">Party Night admin</h1>
        <span className={connected ? 'text-emerald-300' : 'text-amber-300'}>{connected ? 'live' : 'reconnecting...'}</span>
        {state && <span className="text-zinc-400">{state.system.connected} online</span>}
        <div className="ml-auto flex gap-3">
          <a href="/admin/tv" target="_blank" className="rounded-xl bg-sky-600 px-4 py-2 font-semibold">📺 TV mode</a>
          <button
            className="rounded-xl bg-zinc-800 px-4 py-2"
            onClick={() => adminApi.logout().finally(onSignedOut)}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="flex gap-2 border-b border-zinc-800 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-xl px-4 py-2 font-semibold ${tab === t.id ? 'bg-zinc-700' : 'text-zinc-400 hover:bg-zinc-800'}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {toast && <div className="fixed bottom-6 right-6 rounded-xl bg-zinc-100 px-4 py-3 font-semibold text-zinc-900 shadow-lg">{toast}</div>}

      {!state ? (
        <p className="text-zinc-400">Loading...</p>
      ) : tab === 'players' ? (
        <Players players={state.players} send={send} run={run} />
      ) : tab === 'uno' ? (
        <UnoAdmin state={state} send={send} run={run} />
      ) : tab === 'broadcast' ? (
        <Broadcast send={send} run={run} />
      ) : tab === 'audit' ? (
        <Audit entries={state.audit} />
      ) : (
        <System state={state} />
      )}
    </div>
  );
}

type Send = ReturnType<typeof useAdmin>['send'];
type Run = (p: Promise<AdminResult>, okMessage?: string) => Promise<AdminResult>;

const btn = 'rounded-lg bg-zinc-700 px-3 py-1.5 text-sm font-semibold hover:bg-zinc-600';

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Players({ players, send, run }: { players: AdminPlayer[]; send: Send; run: Run }) {
  if (players.length === 0) return <p className="text-zinc-400">Nobody has joined yet. Put the QR code on the TV.</p>;

  const rename = (p: AdminPlayer) => {
    const name = window.prompt(`Rename ${p.name} to:`, p.name);
    if (name && name !== p.name) run(send('admin:rename', { playerId: p.id, name }), 'Renamed');
  };
  const kick = (p: AdminPlayer) => {
    if (window.confirm(`Sign ${p.name} out of their phone? They can rejoin.`)) run(send('admin:kick', { playerId: p.id }), `${p.name} kicked`);
  };
  const ban = (p: AdminPlayer) => {
    if (p.banned) run(send('admin:ban', { playerId: p.id, banned: false }), `${p.name} unbanned`);
    else if (window.confirm(`Ban ${p.name} for the night?`)) run(send('admin:ban', { playerId: p.id, banned: true }), `${p.name} banned`);
  };

  return (
    <table className="w-full text-left">
      <thead className="text-sm text-zinc-400">
        <tr>
          <th className="p-2">Player</th>
          <th className="p-2">Phone</th>
          <th className="p-2">Status</th>
          <th className="p-2">PIN</th>
          <th className="p-2">Points</th>
          <th className="p-2">Last seen</th>
          <th className="p-2" />
        </tr>
      </thead>
      <tbody>
        {players.map((p) => (
          <tr key={p.id} className={`border-t border-zinc-800 ${p.banned ? 'opacity-50' : ''}`}>
            <td className="p-2 text-lg font-semibold">{p.avatar ?? '🙂'} {p.name}</td>
            <td className="p-2 font-mono text-zinc-400">{p.phone}</td>
            <td className="p-2">
              {p.banned ? <span className="text-red-400">banned</span> : p.online ? <span className="text-emerald-300">online</span> : <span className="text-zinc-500">away</span>}
            </td>
            <td className="p-2">{p.hasPin ? '🔒' : '–'}</td>
            <td className="p-2">{p.points}</td>
            <td className="p-2 text-zinc-400">{p.online ? 'now' : ago(p.lastSeen)}</td>
            <td className="flex flex-wrap justify-end gap-2 p-2">
              <button className={btn} onClick={() => rename(p)}>Rename</button>
              {p.hasPin && <button className={btn} onClick={() => run(send('admin:resetPin', { playerId: p.id }), `${p.name}'s PIN reset`)}>Reset PIN</button>}
              {!p.banned && <button className={btn} onClick={() => kick(p)}>Kick</button>}
              <button className={`${btn} ${p.banned ? '' : 'text-red-300'}`} onClick={() => ban(p)}>{p.banned ? 'Unban' : 'Ban'}</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Broadcast({ send, run }: { send: Send; run: Run }) {
  const [text, setText] = useState('');
  const presets = ["Pizza's here 🍕", 'Game starting in 2 minutes', 'Drinks are in the kitchen', 'Everybody grab your phones!'];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await run(send('admin:broadcast', { text }), 'Sent to every phone');
    if (r.ok) setText('');
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-3">
      <p className="text-zinc-400">Shows as a banner on every connected phone until they tap it.</p>
      <textarea
        value={text}
        maxLength={ANNOUNCE_MAX}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="rounded-xl bg-zinc-800 p-3 text-lg outline-none focus:ring-2 focus:ring-emerald-500"
        placeholder="Pizza's here"
      />
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button type="button" key={p} className={btn} onClick={() => setText(p)}>{p}</button>
        ))}
      </div>
      <button className="self-start rounded-xl bg-emerald-600 px-6 py-3 text-lg font-bold disabled:opacity-50" disabled={!text.trim()}>
        📣 Send to everyone
      </button>
    </form>
  );
}

function Audit({ entries }: { entries: AuditEntry[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-zinc-400">
        <tr><th className="p-2">When</th><th className="p-2">Who</th><th className="p-2">Action</th><th className="p-2">Details</th></tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className="border-t border-zinc-800">
            <td className="p-2 whitespace-nowrap text-zinc-400">{new Date(e.createdAt).toLocaleTimeString()}</td>
            <td className="p-2">{e.actor}</td>
            <td className="p-2 font-semibold">{e.action}</td>
            <td className="p-2 font-mono text-zinc-400">{e.payload ? JSON.stringify(e.payload) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function System({ state }: { state: NonNullable<ReturnType<typeof useAdmin>['state']> }) {
  const { system } = state;
  return (
    <dl className="grid max-w-xl grid-cols-[10rem_1fr] gap-x-4 gap-y-3 text-lg">
      <dt className="text-zinc-400">Guest address</dt>
      <dd>{system.joinUrls.length ? system.joinUrls.map((u) => <div key={u} className="font-mono">{u}</div>) : 'Unknown'}</dd>
      <dt className="text-zinc-400">Wi-Fi</dt>
      <dd>{system.wifi.ssid ? `${system.wifi.ssid}${system.wifi.password ? ` / ${system.wifi.password}` : ''}` : 'Not set (WIFI_SSID in .env)'}</dd>
      <dt className="text-zinc-400">Connected now</dt>
      <dd>{system.connected}</dd>
      <dt className="text-zinc-400">Players total</dt>
      <dd>{state.players.length}</dd>
      <dt className="text-zinc-400">Admin access</dt>
      <dd>{system.localOnly ? 'Host laptop only' : 'Open to other devices'}</dd>
    </dl>
  );
}

const PHASE_LABEL = { playing: 'Playing', challenge: 'Waiting on a Draw Four', roundOver: 'Round over', gameOver: 'Game over' } as const;

function UnoAdmin({ state, send, run }: { state: AdminState; send: Send; run: Run }) {
  const live = state.uno;
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState(String(DEFAULT_TARGET_SCORE));
  const [godMode, setGodMode] = useState(false);

  if (!live) {
    const candidates = state.players.filter((p) => !p.banned);
    const toggle = (id: number) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    const ready = picked.size >= MIN_PLAYERS && picked.size <= MAX_PLAYERS;
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <p className="text-zinc-400">Tick who sits at the table ({MIN_PLAYERS}-{MAX_PLAYERS} players), then deal. Seat order is the order below.</p>
        <ul className="flex flex-col gap-2">
          {candidates.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl bg-zinc-800 p-3">
                <input type="checkbox" className="h-5 w-5" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="text-xl">{p.avatar ?? '🙂'}</span>
                <span className="flex-1 text-lg">{p.name}</span>
                <span className={p.online ? 'text-emerald-300' : 'text-zinc-500'}>{p.online ? 'online' : 'away'}</span>
              </label>
            </li>
          ))}
          {candidates.length === 0 && <li className="text-zinc-400">Nobody has joined yet.</li>}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <button className={btn} onClick={() => setPicked(new Set(candidates.filter((p) => p.online).map((p) => p.id).slice(0, MAX_PLAYERS)))}>Tick everyone online</button>
          <label className="flex items-center gap-2 text-zinc-300">
            First to
            <input value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))} className="w-20 rounded-lg bg-zinc-800 p-2 text-center" inputMode="numeric" />
            points
          </label>
        </div>
        <button
          disabled={!ready || !Number(target)}
          className="self-start rounded-xl bg-emerald-600 px-6 py-3 text-lg font-bold disabled:opacity-50"
          onClick={() => run(send('admin:unoCreate', { playerIds: [...picked], targetScore: Number(target) }), 'Dealt!')}
        >
          Deal ({picked.size} seated)
        </button>
      </div>
    );
  }

  const { state: game, seats } = live;
  const name = (id: string) => seats.find((s) => s.id === id)?.name ?? '?';
  const current = game.players[game.current]!;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xl font-bold">{PHASE_LABEL[game.phase]}</span>
        <span className="text-zinc-400">Round {game.round} · first to {game.settings.targetScore}</span>
        {(game.phase === 'playing' || game.phase === 'challenge') && <span className="text-emerald-300">{name(current.id)} to act</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <button className={btn} disabled={game.phase === 'roundOver' || game.phase === 'gameOver'} onClick={() => run(send('admin:unoSkip'), 'Turn skipped')}>Skip turn</button>
          <button className={`${btn} ${game.phase === 'roundOver' ? 'bg-emerald-600' : 'opacity-50'}`} disabled={game.phase !== 'roundOver'} onClick={() => run(send('admin:unoNextRound'), 'Next round dealt')}>Deal next round</button>
          <button className={`${btn} text-red-300`} onClick={() => window.confirm('End the table for everyone?') && run(send('admin:unoEnd'), 'Table closed')}>End table</button>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex flex-col items-center gap-1 text-sm text-zinc-400">
          <Card card={game.discard[game.discard.length - 1]!} width={72} />
          {game.activeColor ?? 'any colour'} · {game.direction === 1 ? 'clockwise' : 'counter-clockwise'}
        </div>
        <label className="ml-auto flex items-center gap-2 text-zinc-300">
          <input type="checkbox" className="h-5 w-5" checked={godMode} onChange={(e) => setGodMode(e.target.checked)} /> God mode (show hands)
        </label>
      </div>

      <table className="w-full text-left">
        <thead className="text-sm text-zinc-400"><tr><th className="p-2">Seat</th><th className="p-2">Player</th><th className="p-2">Cards</th><th className="p-2">Score</th><th className="p-2" /></tr></thead>
        <tbody>
          {game.players.map((p, i) => (
            <tr key={p.id} className={`border-t border-zinc-800 ${p.id === current.id && (game.phase === 'playing' || game.phase === 'challenge') ? 'bg-emerald-500/10' : ''}`}>
              <td className="p-2 text-zinc-400">{i + 1}</td>
              <td className="p-2 text-lg font-semibold">{seats.find((s) => s.id === p.id)?.avatar} {name(p.id)} {seats.find((s) => s.id === p.id)?.online === false && <span className="text-sm font-normal text-zinc-500">(away)</span>}</td>
              <td className="p-2">{p.hand.length}{p.calledUno && ' · UNO'}</td>
              <td className="p-2">{p.score}</td>
              <td className="p-2">
                {godMode && (
                  <div className="flex flex-wrap gap-1">
                    {p.hand.map((c) => <Card key={c.id} card={c} width={44} />)}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="text-sm text-zinc-400">
        {game.log.slice(-8).reverse().map((e, i) => <li key={i}>{describeEvent(e, name)}</li>)}
      </ul>
    </div>
  );
}
