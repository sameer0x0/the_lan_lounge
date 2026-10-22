import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { AdminState } from '@party/shared';
import { Card } from '../uno/Card';
import { describeEvent } from '../uno/log';

/** Full-screen display for the TV / projector: QR code to join, Wi-Fi details, who is here. */
export function Tv({ state }: { state: AdminState | null }) {
  const [qr, setQr] = useState('');
  const url = state?.system.joinUrls[0];

  useEffect(() => {
    if (!url) return;
    // Generated in the browser, so it works with no internet.
    QRCode.toDataURL(url, { width: 720, margin: 2 }).then(setQr);
  }, [url]);

  if (!state) return <p className="p-12 text-3xl text-zinc-400">Loading...</p>;
  const online = state.players.filter((p) => p.online && !p.banned);
  const { wifi } = state.system;
  const table = state.uno;
  const game = table?.state;
  const nameOf = (id: string) => table?.seats.find((s) => s.id === id)?.name ?? '?';

  return (
    <main className="flex min-h-full items-center justify-center gap-16 p-12">
      <section className="flex flex-col items-center gap-6">
        {qr ? <img src={qr} alt="Scan to join" className="w-[min(60vh,40vw)] rounded-3xl bg-white p-2" /> : <p className="text-2xl text-zinc-400">No address found</p>}
        <div className="text-center">
          <p className="text-3xl text-zinc-400">Scan to join, or open</p>
          <p className="font-mono text-5xl font-extrabold">{url}</p>
        </div>
        {wifi.ssid && (
          <p className="text-3xl text-zinc-300">
            📶 Wi-Fi <b>{wifi.ssid}</b>{wifi.password && <> · password <b>{wifi.password}</b></>}
          </p>
        )}
      </section>
      <section className="flex max-h-[80vh] w-[28rem] flex-col gap-4">
        {game && (
          <div className="flex items-center gap-6 rounded-3xl bg-zinc-900 p-5">
            <Card card={game.discard[game.discard.length - 1]!} width={150} />
            <div className="flex flex-col gap-2">
              <p className="text-3xl font-extrabold">
                {game.phase === 'roundOver' ? `${nameOf(game.roundWinnerId ?? '')} won the round` : game.phase === 'gameOver' ? `${nameOf(game.gameWinnerId ?? '')} wins!` : `${nameOf(game.players[game.current]!.id)}'s turn`}
              </p>
              <ul className="text-xl text-zinc-300">
                {game.players.map((p) => <li key={p.id}>{nameOf(p.id)}: {p.hand.length} cards · {p.score} pts</li>)}
              </ul>
              {game.log.length > 0 && <p className="text-lg text-zinc-500">{describeEvent(game.log[game.log.length - 1]!, nameOf)}</p>}
            </div>
          </div>
        )}
        <h1 className="text-5xl font-extrabold">Party Night</h1>
        <p className="text-3xl text-emerald-300">{online.length} here now</p>
        <ul className="flex flex-col gap-2 overflow-hidden">
          {online.map((p) => (
            <li key={p.id} className="text-3xl">{p.avatar ?? '🙂'} {p.name}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
