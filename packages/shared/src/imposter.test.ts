import { describe, expect, it } from 'vitest';
import { allVoted, castVote, createGame, defaultImposterCount, nextRound, resolveVoting, viewFor } from './imposter';

const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const seeded = (): (() => number) => {
  let x = 42;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
};

describe('createGame', () => {
  it('assigns exactly 3 imposters out of 20', () => {
    const s = createGame(mk(20), 3, seeded());
    expect(s.players.filter((p) => p.role === 'imposter')).toHaveLength(3);
  });
  it('scales the default imposter count', () => {
    expect(defaultImposterCount(20)).toBe(3);
    expect(defaultImposterCount(5)).toBe(2);
    expect(defaultImposterCount(3)).toBe(1);
  });
  it('rejects too few players or too many imposters', () => {
    expect(() => createGame(mk(2))).toThrow();
    expect(() => createGame(mk(6), 3)).toThrow();
  });
});

const imposterIds = (s: ReturnType<typeof createGame>) => s.players.filter((p) => p.role === 'imposter').map((p) => p.id);

describe('voting', () => {
  it('ejects the player with the most votes and reveals their role', () => {
    let s = createGame(mk(7), 2, seeded());
    const target = imposterIds(s)[0]!;
    for (const p of s.players) if (p.id !== target) s = castVote(s, p.id, target);
    s = castVote(s, target, 'skip');
    expect(allVoted(s)).toBe(true);
    s = resolveVoting(s);
    expect(s.lastResult).toMatchObject({ ejectedId: target, wasImposter: true });
    expect(s.players.find((p) => p.id === target)!.alive).toBe(false);
    expect(s.phase).toBe('result');
  });
  it('ejects nobody on a tie', () => {
    let s = createGame(mk(5), 1, seeded());
    s = castVote(s, 'p0', 'p1');
    s = castVote(s, 'p1', 'p0');
    s = resolveVoting(s);
    expect(s.lastResult!.ejectedId).toBeNull();
    expect(s.players.every((p) => p.alive)).toBe(true);
  });
  it('ejects nobody when skip wins, and non-voters count as skip', () => {
    let s = createGame(mk(5), 1, seeded());
    s = castVote(s, 'p0', 'p1');
    s = resolveVoting(s);
    expect(s.lastResult!.ejectedId).toBeNull();
  });
  it('blocks self-votes, dead voters, dead targets and late votes', () => {
    let s = createGame(mk(7), 2, seeded());
    expect(() => castVote(s, 'p0', 'p0')).toThrow();
    const target = imposterIds(s)[0]!;
    for (const p of s.players) if (p.id !== target) s = castVote(s, p.id, target);
    s = resolveVoting(s);
    expect(() => castVote(s, 'p0', 'skip')).toThrow(); // phase is result
    s = nextRound(s);
    expect(() => castVote(s, target, 'skip')).toThrow(); // ejected
    expect(() => castVote(s, 'p0', target)).toThrow(); // dead target
  });
  it('lets a player change their vote', () => {
    let s = createGame(mk(5), 1, seeded());
    s = castVote(castVote(s, 'p0', 'p1'), 'p0', 'p2');
    expect(s.votes.p0).toBe('p2');
  });
});

describe('win conditions', () => {
  it('crew win when every imposter is ejected', () => {
    let s = createGame(mk(7), 2, seeded());
    for (const id of imposterIds(s)) {
      for (const p of s.players.filter((x) => x.alive && x.id !== id)) s = castVote(s, p.id, id);
      s = resolveVoting(s);
      if (s.phase === 'result') s = nextRound(s);
    }
    expect(s.winner).toBe('crew');
    expect(s.phase).toBe('ended');
  });
  it('imposters win when they equal the living crew', () => {
    let s = createGame(mk(5), 2, seeded());
    const crew = s.players.filter((p) => p.role === 'crew').map((p) => p.id);
    const imps = imposterIds(s);
    // Everyone (except the victim) votes out one crewmate: 3 crew -> 2 crew vs 2 imposters.
    const victim = crew[0]!;
    for (const p of s.players.filter((x) => x.id !== victim)) s = castVote(s, p.id, victim);
    s = resolveVoting(s);
    expect(imps.length).toBe(2);
    expect(s.winner).toBe('imposters');
  });
});

describe('viewFor (privacy)', () => {
  it('hides other roles from crew and shows teammates to imposters', () => {
    const s = createGame(mk(8), 3, seeded());
    const [a, b, c] = imposterIds(s);
    const crewId = s.players.find((p) => p.role === 'crew')!.id;
    const crewView = viewFor(s, crewId);
    expect(crewView.teammates).toEqual([]);
    expect(crewView.players.every((p) => p.role === undefined)).toBe(true);
    const impView = viewFor(s, a!);
    expect(impView.teammates.map((t) => t.id).sort()).toEqual([b, c].sort());
    expect(JSON.stringify(crewView)).not.toContain(`"role":"imposter","name"`);
  });
  it('reveals all roles once the game has ended', () => {
    let s = createGame(mk(5), 1, seeded());
    const imp = imposterIds(s)[0]!;
    for (const p of s.players.filter((x) => x.id !== imp)) s = castVote(s, p.id, imp);
    s = resolveVoting(s);
    expect(viewFor(s, 'p0').players.every((p) => p.role !== undefined)).toBe(true);
  });
});
