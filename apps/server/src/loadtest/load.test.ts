import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDb } from '../db/index.js';
import { formatReport, runLoadTest } from './run.js';

/** 20 phones, a 10-seat UNO game played to the end by bots, and a server restart in the middle. */
describe('20 players', () => {
  it('join, play a full UNO game and survive a server restart mid-game', async () => {
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
      { players: 20, seats: 10, targetScore: 60, restartAfterMoves: 25, thinkMs: 0, announcements: 5, timeoutMs: 90_000, log: () => {} },
    );

    console.log(formatReport(report));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.restartRecoveryMs).not.toBeNull();
    expect(report.moves).toBeGreaterThan(40);
    await new Promise<void>((r) => void built.io.close(() => r()));
    await built.app.close().catch(() => {});
  }, 120_000);
});
