import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDb } from '../db/index.js';
import { formatReport, runLoadTest } from './run.js';

/** 20 phones, a UNO game played to the end by bots, and a server restart in the middle. */
describe('20 players', () => {
  /** `seats` of the 20 sit at the table (11+ plays with two decks); the rest spectate. */
  async function scenario(seats: number) {
    const { db } = openDb(':memory:');
    const start = async (port: number) => {
      const built = await buildApp({ db, adminPassword: 'pw' });
      await built.app.listen({ port, host: '127.0.0.1' });
      return built;
    };
    let built = await start(0);
    const port = (built.app.server.address() as AddressInfo).port;

    const report = await runLoadTest(
      {
        url: `http://127.0.0.1:${port}`,
        adminPassword: 'pw',
        async restart() {
          // abrupt: drop every connection, then come back on the same port with the same database
          await new Promise<void>((r) => void built.io.close(() => r()));
          await built.app.close().catch(() => {});
          built = await start(port);
        },
      },
      { players: 20, seats, targetScore: 60, restartAfterMoves: 25, thinkMs: 0, announcements: 5, timeoutMs: 90_000, log: () => {} },
    );

    console.log(formatReport(report));
    await new Promise<void>((r) => void built.io.close(() => r()));
    await built.app.close().catch(() => {});
    return report;
  }

  it('all 20 sit at one UNO table, play a full game and survive a server restart mid-game', async () => {
    const report = await scenario(20);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.restartRecoveryMs).not.toBeNull();
    expect(report.moves).toBeGreaterThan(40);
  }, 120_000);

  it('10 sit at the table while 10 spectate, and the spectators never see the game', async () => {
    const report = await scenario(10);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);
});
