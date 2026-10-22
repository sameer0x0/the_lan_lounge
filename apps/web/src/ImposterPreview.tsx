import { useMemo, useState } from 'react';
import {
  allVoted,
  castVote,
  createGame,
  nextRound,
  resolveVoting,
  viewFor,
  type ImposterState,
  type Me,
  type PlayerPublic,
} from '@party/shared';

// Practice mode: runs the shared engine locally with the REAL people currently online, so there are
// no made-up names. Other players' votes are simulated here; real games run on the server
// (see docs/PROGRESS.md, "Wiring Imposter to real players").
export function ImposterPreview({ me, players, onExit }: { me: Me; players: PlayerPublic[]; onExit: () => void }) {
  const roster = useMemo(
    () => players.filter((p) => p.online || p.id === me.id).map((p) => ({ id: String(p.id), name: p.name })),
    // freeze the roster for the duration of one practice game
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const myId = String(me.id);
  const [state, setState] = useState<ImposterState | null>(() => (roster.length >= 3 ? createGame(roster) : null));
  const [revealed, setRevealed] = useState(false);

  if (!state) {
    return (
      <main className="mx-auto flex min-h-full max-w-md flex-col gap-5 p-6">
        <button onClick={onExit} className="self-start text-zinc-400">← Games</button>
        <h1 className="text-3xl font-extrabold">Imposter</h1>
        <p className="rounded-2xl bg-zinc-800 p-5 text-lg text-zinc-300">
          Imposter needs at least 3 people online. Right now there {roster.length === 1 ? 'is' : 'are'} {roster.length}.
        </p>
      </main>
    );
  }

  const view = viewFor(state, myId);
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.name ?? id;

  const vote = (target: string) => {
    let s = castVote(state, myId, target);
    for (const p of s.players) {
      if (p.alive && p.id !== myId && s.votes[p.id] === undefined) {
        const options = s.players.filter((x) => x.alive && x.id !== p.id).map((x) => x.id);
        s = castVote(s, p.id, Math.random() < 0.15 ? 'skip' : options[Math.floor(Math.random() * options.length)]!);
      }
    }
    setState(allVoted(s) ? resolveVoting(s) : s);
  };

  const restart = () => {
    setState(createGame(roster));
    setRevealed(false);
  };

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col gap-5 p-6">
      <button onClick={onExit} className="self-start text-zinc-400">← Games</button>
      <h1 className="text-3xl font-extrabold">Imposter <span className="text-base font-medium text-zinc-400">(practice)</span></h1>
      <p className="text-sm text-zinc-500">Practice round with the people online. Their votes are simulated until live games are wired up.</p>

      {!revealed ? (
        <button onClick={() => setRevealed(true)} className="rounded-2xl bg-zinc-800 p-8 text-xl font-bold active:bg-zinc-700">
          Tap to see your role
        </button>
      ) : (
        <div className={`rounded-2xl p-5 text-center ${view.you.role === 'imposter' ? 'bg-red-600/30 text-red-200' : 'bg-sky-600/30 text-sky-200'}`}>
          <div className="text-3xl font-extrabold">{view.you.role === 'imposter' ? 'You are an IMPOSTER' : 'You are CREW'}</div>
          {view.teammates.length > 0 && <div className="mt-1">With: {view.teammates.map((t) => t.name).join(', ')}</div>}
        </div>
      )}

      {view.phase === 'voting' && view.you.alive && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-bold">Round {view.round}: vote someone out</h2>
          {view.players.filter((p) => p.alive && p.id !== myId).map((p) => (
            <button key={p.id} onClick={() => vote(p.id)} className="rounded-2xl bg-zinc-800 p-4 text-left text-xl font-semibold active:bg-red-600/40">
              {p.name}
            </button>
          ))}
          <button onClick={() => vote('skip')} className="rounded-2xl border border-zinc-600 p-4 text-xl text-zinc-300">Skip vote</button>
        </section>
      )}

      {(view.phase === 'result' || view.phase === 'ended') && view.lastResult && (
        <section className="rounded-2xl bg-zinc-800 p-5 text-center">
          {view.lastResult.ejectedId ? (
            <>
              <div className="text-2xl font-bold">{nameOf(view.lastResult.ejectedId)} was ejected</div>
              <div className={`mt-1 text-xl font-extrabold ${view.lastResult.wasImposter ? 'text-red-400' : 'text-sky-300'}`}>
                {view.lastResult.wasImposter ? 'They WERE an imposter' : 'They were NOT an imposter'}
              </div>
            </>
          ) : (
            <div className="text-2xl font-bold">No one was ejected</div>
          )}
        </section>
      )}

      {view.phase === 'result' && (
        <button onClick={() => setState(nextRound(state))} className="rounded-2xl bg-emerald-600 p-4 text-xl font-bold">Next round</button>
      )}

      {view.phase === 'ended' && (
        <section className="flex flex-col gap-3">
          <div className="text-center text-3xl font-extrabold">{view.winner === 'crew' ? 'Crew wins!' : 'Imposters win!'}</div>
          <ul className="rounded-2xl bg-zinc-800 p-4">
            {view.players.map((p) => (
              <li key={p.id} className="flex justify-between py-1 text-lg">
                <span>{p.name}</span>
                <span className={p.role === 'imposter' ? 'text-red-400' : 'text-sky-300'}>{p.role}</span>
              </li>
            ))}
          </ul>
          <button onClick={restart} className="rounded-2xl bg-emerald-600 p-4 text-xl font-bold">Play again</button>
        </section>
      )}
    </main>
  );
}
