import { useEffect, useRef, useState } from 'react';
import { Admin } from './admin/Admin';
import { PinSettings } from './PinSettings';
import { GAMES, type Announcement, type KickReason, type Me, type PlayerPublic, type UnoPayload } from '@party/shared';
import { api } from './api';
import { ImposterPreview } from './ImposterPreview';
import { Join } from './Join';
import { socket } from './socket';
import { UnoTable } from './uno/UnoTable';

const KICK_TEXT: Record<KickReason, string> = {
  otherDevice: 'You signed in on another device, so this one was signed out.',
  admin: 'The host removed you from the party.',
  banned: 'You are not allowed in tonight.',
};

export function App() {
  return window.location.pathname.startsWith('/admin') ? <Admin /> : <PlayerApp />;
}

function PlayerApp() {
  // undefined = still checking the cookie, null = signed out
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  if (me === undefined) return <main className="p-6 text-center text-zinc-400">Loading...</main>;
  if (me === null) {
    return (
      <>
        {notice && <p className="bg-amber-500/20 p-4 text-center text-amber-200">{notice}</p>}
        <Join
          onDone={(m, back) => {
            setNotice(back ? `Welcome back, ${m.name}` : '');
            setMe(m);
          }}
        />
      </>
    );
  }
  return (
    <Home
      me={me}
      notice={notice}
      onSignedOut={(msg) => {
        setNotice(msg);
        setMe(null);
      }}
    />
  );
}

function Home({ me: initial, notice, onSignedOut }: { me: Me; notice: string; onSignedOut: (msg: string) => void }) {
  const [me, setMe] = useState(initial);
  const [players, setPlayers] = useState<PlayerPublic[]>([]);
  const [connected, setConnected] = useState(false);
  const [preview, setPreview] = useState(false);
  const [banner, setBanner] = useState<Announcement | null>(null);
  const [uno, setUno] = useState<UnoPayload | null>(null);
  const [inTable, setInTable] = useState(false);
  const hadTable = useRef(false);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onSync = (s: { me: Me; players: PlayerPublic[]; uno: UnoPayload | null }) => {
      setMe(s.me);
      setPlayers(s.players);
      setUno(s.uno);
    };
    const onAnnounce = (a: Announcement) => {
      setBanner(a);
      navigator.vibrate?.(200);
    };
    const onKicked = ({ reason }: { reason: KickReason }) => onSignedOut(KICK_TEXT[reason]);
    // Session expired / revoked while away: Socket.IO reports it as a connect error.
    const onError = (err: Error) => err.message === 'unauthorized' && onSignedOut('Please sign in again.');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('sync', onSync);
    socket.on('lobby:update', setPlayers);
    socket.on('uno:state', setUno);
    socket.on('kicked', onKicked);
    socket.on('announce', onAnnounce);
    socket.on('connect_error', onError);
    socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('sync', onSync);
      socket.off('lobby:update', setPlayers);
      socket.off('uno:state', setUno);
      socket.off('kicked', onKicked);
      socket.off('announce', onAnnounce);
      socket.off('connect_error', onError);
      socket.disconnect();
    };
  }, [onSignedOut]);

  // Open the table by itself when a game is dealt to you (or when you reopen the page mid-game).
  useEffect(() => {
    if (uno && !hadTable.current) setInTable(true);
    if (!uno) setInTable(false);
    hadTable.current = !!uno;
  }, [uno]);

  if (inTable && uno) return <UnoTable payload={uno} onExit={() => setInTable(false)} />;
  if (preview) return <ImposterPreview me={me} players={players} onExit={() => setPreview(false)} />;

  const online = players.filter((p) => p.online).length;

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-6 p-6">
      {banner && (
        <button
          onClick={() => setBanner(null)}
          className="fixed inset-x-0 top-0 z-10 bg-amber-400 p-4 text-center text-xl font-bold text-black shadow-lg"
        >
          📣 {banner.text}
        </button>
      )}
      {notice && <p className="rounded-2xl bg-emerald-500/20 p-3 text-center text-emerald-200">{notice}</p>}
      <header className="text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">
          {me.avatar} {me.name}
        </h1>
        <p className={`mt-2 ${connected ? 'text-emerald-300' : 'text-amber-300'}`}>
          {connected ? `${online} online` : 'Reconnecting...'}
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {GAMES.map((g) => {
          const unoSeated = g.id === 'uno' && !!uno;
          const locked = !g.enabled || (g.id === 'uno' && !uno);
          return (
          <li key={g.id}>
            <button
              disabled={locked}
              onClick={() => (g.id === 'imposter' ? setPreview(true) : unoSeated && setInTable(true))}
              className="w-full rounded-2xl bg-zinc-800 p-5 text-left enabled:active:bg-zinc-700 disabled:opacity-40"
            >
              <span className="block text-2xl font-bold">
                {g.name}
                {!g.enabled && <span className="ml-2 text-sm font-medium text-zinc-400">(off for now)</span>}
              </span>
              <span className="block text-zinc-400">
                {unoSeated ? 'Your table is live. Tap to sit down.' : g.id === 'uno' && g.enabled ? 'Waiting for the host to seat you.' : g.blurb}
              </span>
            </button>
          </li>
          );
        })}
      </ul>

      <section>
        <h2 className="mb-2 text-xl font-bold">Who's here</h2>
        <ul className="flex flex-col gap-2">
          {players.map((p) => (
            <li key={p.id} className={`flex items-center gap-3 rounded-2xl bg-zinc-800 p-3 ${p.online ? '' : 'opacity-50'}`}>
              <span className="text-2xl">{p.avatar ?? '🙂'}</span>
              <span className="flex-1 text-lg">{p.name}{p.id === me.id && ' (you)'}</span>
              <span className={`text-sm ${p.online ? 'text-emerald-300' : 'text-zinc-500'}`}>{p.online ? 'online' : 'away'}</span>
            </li>
          ))}
        </ul>
      </section>

      <PinSettings me={me} onChange={setMe} />

      <button
        className="self-center text-zinc-500"
        onClick={() => api.logout().finally(() => onSignedOut(''))}
      >
        Sign out
      </button>
    </main>
  );
}
