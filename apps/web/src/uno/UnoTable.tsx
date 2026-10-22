import { useEffect, useMemo, useState } from 'react';
import { UNO_COLORS, buildDeck, cardAsset, CARD_BACK, type UnoCard, type UnoColor, type UnoPayload } from '@party/shared';
import { COLOR_HEX, Card, CardBack } from './Card';
import { describeEvent } from './log';
import { sendUno } from './send';

const COLOR_ORDER: Record<string, number> = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
const KIND_ORDER: Record<string, number> = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, wild4: 5 };

/** Easier to scan: by colour, then numbers, then action cards. Display only; the server's order is untouched. */
const sortHand = (hand: UnoCard[]) =>
  [...hand].sort(
    (a, b) =>
      COLOR_ORDER[a.color]! - COLOR_ORDER[b.color]! ||
      KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]! ||
      (a.value ?? 0) - (b.value ?? 0) ||
      a.id - b.id,
  );

/** Warm the browser cache so cards never pop in mid-game. */
function usePreloadCards() {
  useEffect(() => {
    const assets = new Set([CARD_BACK, ...buildDeck().map(cardAsset)]);
    assets.forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }, []);
}

export function UnoTable({ payload, onExit }: { payload: UnoPayload; onExit: () => void }) {
  const { view, seats } = payload;
  usePreloadCards();

  const [picking, setPicking] = useState<UnoCard | null>(null); // a Wild waiting for its colour
  const [toast, setToast] = useState('');

  const name = (id: string) => seats.find((s) => s.id === id)?.name ?? '?';
  const seat = (id: string) => seats.find((s) => s.id === id);
  const myTurn = view.currentPlayerId === view.you.id && view.phase === 'playing';
  const hand = useMemo(() => sortHand(view.you.hand), [view.you.hand]);

  // Buzz when it becomes your turn, so you can look away from the screen.
  useEffect(() => {
    if (myTurn) navigator.vibrate?.(150);
  }, [myTurn]);

  async function run(p: Promise<{ ok: true } | { ok: false; error: string }>) {
    const r = await p;
    if (!r.ok) {
      setToast(r.error);
      setTimeout(() => setToast(''), 2500);
    }
  }

  const play = (card: UnoCard) => {
    if (card.color === 'wild') return setPicking(card);
    run(sendUno('uno:play', { cardId: card.id }));
  };
  const pickColor = (color: UnoColor) => {
    const card = picking!;
    setPicking(null);
    run(sendUno('uno:play', { cardId: card.id, color }));
  };

  const iAmChallenged = view.challenge?.targetId === view.you.id;
  const opponents = view.players.filter((p) => p.id !== view.you.id);
  const lines = view.log.slice(-3).map((e) => describeEvent(e, name));
  const status = (() => {
    if (view.phase !== 'playing' && view.phase !== 'challenge') return '';
    if (view.challenge) return iAmChallenged ? `${name(view.challenge.fromId)} played a Wild Draw Four` : `Waiting for ${name(view.challenge.targetId)}...`;
    if (myTurn) return view.canPass ? 'Play the card you drew, or pass' : view.playable.length ? 'Your turn' : 'Nothing to play: draw a card';
    return `${name(view.currentPlayerId)}'s turn`;
  })();

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#0b0b12] text-white">
      {/* top bar */}
      <div className="flex items-center justify-between px-3 pt-3 text-sm text-zinc-400">
        <button onClick={onExit} className="rounded-lg bg-zinc-800 px-3 py-2">← Lobby</button>
        <span>Round {view.round} · first to {view.targetScore}</span>
        <Direction dir={view.direction} />
      </div>

      {/* opponents */}
      <div className="flex gap-3 overflow-x-auto px-3 py-3">
        {opponents.map((p) => {
          const s = seat(p.id);
          const turn = p.id === view.currentPlayerId && view.phase !== 'roundOver' && view.phase !== 'gameOver';
          return (
            <div key={p.id} className={`relative flex w-20 shrink-0 flex-col items-center gap-1 rounded-2xl p-2 ${turn ? 'bg-emerald-500/20 ring-2 ring-emerald-400' : 'bg-zinc-900'} ${s?.online === false ? 'opacity-50' : ''}`}>
              <span className="text-2xl leading-none">{s?.avatar ?? '🙂'}</span>
              <span className="w-full truncate text-center text-xs">{name(p.id)}</span>
              <div className="relative">
                <CardBack width={34} />
                <span className="absolute -right-2 -top-2 rounded-full bg-white px-1.5 text-xs font-extrabold text-black">{p.cardCount}</span>
              </div>
              <span className="text-[10px] text-zinc-400">{p.score} pts</span>
              {p.uno && <span className="absolute -bottom-2 rounded-full bg-yellow-400 px-2 text-[11px] font-extrabold text-black">UNO!</span>}
            </div>
          );
        })}
      </div>

      {/* table: draw pile + discard */}
      <div className="flex flex-1 items-center justify-center gap-8">
        <button
          disabled={!view.canDraw}
          onClick={() => run(sendUno('uno:draw'))}
          className={`relative touch-manipulation rounded-2xl ${view.canDraw ? 'ring-4 ring-emerald-400' : 'opacity-80'}`}
          aria-label="Draw a card"
        >
          <CardBack width={92} />
          <span className="absolute inset-x-0 -bottom-6 text-center text-sm text-zinc-400">{view.drawPileCount}</span>
        </button>
        <div className="relative">
          {/* the colour in force: a ring around the top card, vital after a Wild */}
          <div className="rounded-2xl p-1.5" style={{ background: view.activeColor ? COLOR_HEX[view.activeColor] : 'repeating-conic-gradient(#D32F2F 0 25%,#1565C0 0 50%,#FBC02D 0 75%,#2E7D32 0 100%)' }}>
            <Card card={view.top} width={108} />
          </div>
        </div>
      </div>

      {/* status + log */}
      <div className="min-h-[3.5rem] px-4 text-center">
        <p className={`text-lg font-bold ${myTurn ? 'text-emerald-300' : 'text-zinc-300'}`}>{status}</p>
        <p className="truncate text-xs text-zinc-500">{lines.join('  ·  ')}</p>
      </div>

      {/* actions */}
      <div className="flex min-h-[3.75rem] items-center justify-center gap-3 px-3 pb-2">
        {view.you.hand.length <= 2 && view.phase === 'playing' && (
          <button onClick={() => run(sendUno('uno:callUno'))} className={`rounded-full px-6 py-3 text-xl font-extrabold ${view.you.calledUno ? 'bg-yellow-400/40 text-black/60' : 'bg-yellow-400 text-black active:bg-yellow-300'}`}>
            UNO!
          </button>
        )}
        {view.catchable && view.catchable !== view.you.id && (
          <button onClick={() => run(sendUno('uno:catch'))} className="rounded-full bg-red-600 px-6 py-3 text-xl font-extrabold active:bg-red-500">
            Catch {name(view.catchable)}!
          </button>
        )}
        {view.canPass && (
          <button onClick={() => run(sendUno('uno:pass'))} className="rounded-full bg-zinc-700 px-6 py-3 text-xl font-bold active:bg-zinc-600">
            Pass
          </button>
        )}
      </div>

      {/* hand */}
      <div className="overflow-x-auto px-3 pb-5 pt-5">
        <div className="mx-auto flex w-max items-end -space-x-8">
          {hand.map((c) => {
            const playable = view.playable.includes(c.id);
            return <Card key={c.id} card={c} width={88} playable={playable} dimmed={myTurn && !playable} onClick={() => play(c)} />;
          })}
        </div>
      </div>

      {toast && <div className="pointer-events-none absolute inset-x-6 top-16 rounded-xl bg-red-600 px-4 py-3 text-center font-semibold shadow-lg">{toast}</div>}

      {/* Wild colour picker */}
      {picking && (
        <Modal onClose={() => setPicking(null)}>
          <p className="mb-4 text-center text-2xl font-bold">Pick a colour</p>
          <div className="grid grid-cols-2 gap-4">
            {UNO_COLORS.map((c) => (
              <button key={c} onClick={() => pickColor(c)} aria-label={c} className="h-28 rounded-3xl active:scale-95" style={{ background: COLOR_HEX[c] }} />
            ))}
          </div>
        </Modal>
      )}

      {/* Wild Draw Four aimed at you */}
      {iAmChallenged && view.challenge && (
        <Modal>
          <p className="mb-3 text-center text-xl font-bold">{name(view.challenge.fromId)} played</p>
          <div className="mb-4 flex justify-center">
            <img src={cardAsset({ color: 'wild', kind: 'wild4', value: null })} alt="Wild Draw Four" width={120} height={180} className="rounded-xl" />
          </div>
          <div className="flex flex-col gap-3">
            <button onClick={() => run(sendUno('uno:challenge'))} className="rounded-2xl bg-red-600 p-4 text-xl font-extrabold active:bg-red-500">
              Challenge it!
            </button>
            <button onClick={() => run(sendUno('uno:draw'))} className="rounded-2xl bg-zinc-700 p-4 text-xl font-bold active:bg-zinc-600">
              Just draw 4
            </button>
          </div>
          <p className="mt-3 text-center text-sm text-zinc-400">Right: they draw 4. Wrong: you draw 6.</p>
        </Modal>
      )}

      {/* round / game over */}
      {(view.phase === 'roundOver' || view.phase === 'gameOver') && (
        <Modal>
          <div className="text-center">
            <p className="text-5xl">{view.phase === 'gameOver' ? '🏆' : '🎉'}</p>
            <p className="mt-2 text-2xl font-extrabold">
              {name((view.phase === 'gameOver' ? view.gameWinnerId : view.roundWinnerId) ?? '')}
              {view.phase === 'gameOver' ? ' wins the game!' : ' won the round'}
            </p>
            {view.phase === 'roundOver' && <p className="text-zinc-400">+{view.roundPoints} points</p>}
          </div>
          <ul className="my-4 flex flex-col gap-2">
            {[...view.players].sort((a, b) => b.score - a.score).map((p) => (
              <li key={p.id} className="rounded-xl bg-zinc-800 p-3">
                <div className="flex justify-between"><span>{seat(p.id)?.avatar} {name(p.id)}{p.id === view.you.id && ' (you)'}</span><b>{p.score}</b></div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-700"><div className="h-full bg-emerald-400" style={{ width: `${Math.min(100, (p.score / view.targetScore) * 100)}%` }} /></div>
              </li>
            ))}
          </ul>
          {view.phase === 'roundOver' ? (
            <p className="text-center text-zinc-400">Waiting for the host to deal the next round...</p>
          ) : (
            <button onClick={onExit} className="w-full rounded-2xl bg-emerald-600 p-4 text-xl font-bold">Back to lobby</button>
          )}
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 p-6" onClick={onClose}>
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-3xl bg-zinc-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** Two curved arrows showing which way play is going. */
function Direction({ dir }: { dir: 1 | -1 }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: dir === 1 ? undefined : 'scaleX(-1)' }} aria-label={dir === 1 ? 'Clockwise' : 'Counter-clockwise'}>
      <path d="M20 12a8 8 0 1 1-3-6.2" />
      <path d="M20 3v5h-5" />
    </svg>
  );
}
