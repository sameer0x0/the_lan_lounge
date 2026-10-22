/**
 * Imposter ("Among Us" style) rules engine. Pure functions, no I/O.
 * The server owns the state; clients only ever see `viewFor(...)`.
 */
import { shuffle, type Rng } from './random';

export type Role = 'crew' | 'imposter';
export type Phase = 'voting' | 'result' | 'ended';
export type Winner = 'crew' | 'imposters';
/** A vote is for a player id, or 'skip'. */
export type Vote = string | 'skip';

export interface ImposterPlayer {
  id: string;
  name: string;
  role: Role;
  alive: boolean;
}

export interface ImposterState {
  phase: Phase;
  round: number;
  players: ImposterPlayer[];
  /** voterId -> vote, for the current round. */
  votes: Record<string, Vote>;
  /** Outcome of the last tally, shown during `result` and `ended`. */
  lastResult: { ejectedId: string | null; wasImposter: boolean | null; tally: Record<string, number> } | null;
  winner: Winner | null;
}

/** Default imposter count: 3 for a big party, scaled down so crew always outnumber them. */
export function defaultImposterCount(playerCount: number): number {
  return Math.max(1, Math.min(3, Math.floor((playerCount - 1) / 2)));
}

export function createGame(
  players: { id: string; name: string }[],
  imposterCount: number = defaultImposterCount(players.length),
  rng: Rng = Math.random,
): ImposterState {
  if (players.length < 3) throw new Error('Need at least 3 players');
  if (imposterCount < 1 || imposterCount * 2 >= players.length) {
    throw new Error('Imposters must be fewer than half the players');
  }
  const imposterIds = new Set(shuffle(players, rng).slice(0, imposterCount).map((p) => p.id));
  return {
    phase: 'voting',
    round: 1,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      role: imposterIds.has(p.id) ? 'imposter' : 'crew',
      alive: true,
    })),
    votes: {},
    lastResult: null,
    winner: null,
  };
}

const alive = (s: ImposterState) => s.players.filter((p) => p.alive);

/** Records or changes a vote. Returns a new state. Only living players vote, only during `voting`. */
export function castVote(s: ImposterState, voterId: string, vote: Vote): ImposterState {
  if (s.phase !== 'voting') throw new Error('Voting is closed');
  const voter = s.players.find((p) => p.id === voterId);
  if (!voter?.alive) throw new Error('Only living players can vote');
  if (vote !== 'skip') {
    const target = s.players.find((p) => p.id === vote);
    if (!target?.alive) throw new Error('Invalid vote target');
    if (target.id === voterId) throw new Error('You cannot vote for yourself');
  }
  return { ...s, votes: { ...s.votes, [voterId]: vote } };
}

export function allVoted(s: ImposterState): boolean {
  return alive(s).every((p) => s.votes[p.id] !== undefined);
}

/**
 * Closes voting. Most votes ejects that player; a tie for first, or skip winning/tying, ejects nobody.
 * Players who did not vote count as skipping. Then checks win conditions.
 */
export function resolveVoting(s: ImposterState): ImposterState {
  if (s.phase !== 'voting') throw new Error('Not in a voting phase');
  const tally: Record<string, number> = {};
  for (const p of alive(s)) {
    const v = s.votes[p.id] ?? 'skip';
    tally[v] = (tally[v] ?? 0) + 1;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const tied = ranked.length > 1 && ranked[1]![1] === top![1];
  const ejectedId = top && !tied && top[0] !== 'skip' ? top[0] : null;

  const players = s.players.map((p) => (p.id === ejectedId ? { ...p, alive: false } : p));
  const ejected = players.find((p) => p.id === ejectedId);
  const imposters = players.filter((p) => p.alive && p.role === 'imposter').length;
  const crew = players.filter((p) => p.alive && p.role === 'crew').length;
  const winner: Winner | null = imposters === 0 ? 'crew' : imposters >= crew ? 'imposters' : null;

  return {
    ...s,
    players,
    phase: winner ? 'ended' : 'result',
    lastResult: { ejectedId, wasImposter: ejected ? ejected.role === 'imposter' : null, tally },
    winner,
  };
}

/** Moves from `result` into the next voting round. */
export function nextRound(s: ImposterState): ImposterState {
  if (s.phase !== 'result') throw new Error('Round is not finished');
  return { ...s, phase: 'voting', round: s.round + 1, votes: {} };
}

export interface ImposterView {
  phase: Phase;
  round: number;
  you: { id: string; role: Role; alive: boolean };
  /** Fellow imposters, only populated for imposters. */
  teammates: { id: string; name: string }[];
  players: { id: string; name: string; alive: boolean; hasVoted: boolean; role?: Role }[];
  yourVote: Vote | null;
  lastResult: ImposterState['lastResult'];
  winner: Winner | null;
}

/**
 * The only thing a player's phone ever receives. Roles of others stay hidden until the game
 * ends. Ejected players' roles are revealed through `lastResult`, not here.
 */
export function viewFor(s: ImposterState, playerId: string): ImposterView {
  const me = s.players.find((p) => p.id === playerId);
  if (!me) throw new Error('Unknown player');
  const ended = s.phase === 'ended';
  return {
    phase: s.phase,
    round: s.round,
    you: { id: me.id, role: me.role, alive: me.alive },
    teammates:
      me.role === 'imposter' ? s.players.filter((p) => p.role === 'imposter' && p.id !== me.id).map((p) => ({ id: p.id, name: p.name })) : [],
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      hasVoted: s.votes[p.id] !== undefined,
      ...(ended ? { role: p.role } : {}),
    })),
    yourVote: s.votes[playerId] ?? null,
    lastResult: s.lastResult,
    winner: s.winner,
  };
}
