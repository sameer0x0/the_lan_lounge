/**
 * `npm run loadtest` : 20 fake phones play a full UNO game against a real, separate server process, which is
 * killed and restarted mid-game. Uses a throwaway database, so your party data is never touched.
 *
 *   npm run loadtest                         # 20 players, 10 at the table
 *   npm run loadtest -- --players 20 --seats 10 --score 300 --think 400
 *   npm run loadtest -- --restart-after none
 *   npm run loadtest -- --url http://192.168.0.10:3000 --admin-password ...   (an already-running server;
 *                                                          adds fake "Load.." players to ITS database!)
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { formatReport, runLoadTest, type ServerCtl } from '../apps/server/src/loadtest/run';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const players = Number(arg('players', '20'));
const seats = Number(arg('seats', String(Math.min(10, players))));
const score = Number(arg('score', '150'));
const think = Number(arg('think', '0'));
const restartArg = arg('restart-after', '60');
const existingUrl = arg('url');
const port = Number(arg('port', '3199'));
const password = arg('admin-password', 'loadtest-password')!;

let child: ChildProcess | null = null;
const dbDir = mkdtempSync(join(tmpdir(), 'party-night-load-'));

/** Starts the real server entry point as its own process and resolves once it is listening. */
function startServer(): Promise<void> {
  return new Promise((resolveStart, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', resolve(root, 'apps/server/src/index.ts')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), DB_PATH: join(dbDir, 'party.sqlite'), ADMIN_PASSWORD: password, ADMIN_ALLOW_REMOTE: '0', PUBLIC_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = p;
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start in 30 s:\n${out}`)), 30_000);
    p.stdout!.on('data', (d) => {
      out += d;
      if (out.includes('Party Night is up')) {
        clearTimeout(timer);
        resolveStart();
      }
    });
    p.stderr!.on('data', (d) => (out += d));
    p.on('exit', (code) => {
      if (!out.includes('Party Night is up')) {
        clearTimeout(timer);
        reject(new Error(`Server exited (${code}) before starting:\n${out}`));
      }
    });
  });
}

function killServer(): Promise<void> {
  return new Promise((r) => {
    if (!child || child.exitCode !== null) return r();
    child.once('exit', () => r());
    child.kill('SIGKILL'); // abrupt on purpose: no graceful shutdown, like pulling the plug on the process
  });
}

/** Resident memory of the server process, best effort on macOS/Linux/Windows. */
async function rssMb(): Promise<number | null> {
  const pid = child?.pid;
  if (!pid) return null;
  const run = promisify(execFile);
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      const kb = Number(stdout.trim().split('","').pop()?.replace(/[^\d]/g, ''));
      return kb ? Math.round(kb / 1024) : null;
    }
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
    return Math.round(Number(stdout.trim()) / 1024);
  } catch {
    return null;
  }
}

async function main() {
  let ctl: ServerCtl;
  let restartAfterMoves: number | null = restartArg === 'none' ? null : Number(restartArg);

  if (existingUrl) {
    console.log(`Targeting the running server at ${existingUrl}. This adds ${players} fake "Load.." players to ITS database.`);
    restartAfterMoves = null; // we don't own that process
    ctl = { url: existingUrl, adminPassword: password, restart: async () => {} };
  } else {
    console.log(`Starting an isolated server on port ${port} (temporary database in ${dbDir})...`);
    await startServer();
    ctl = {
      url: `http://127.0.0.1:${port}`,
      adminPassword: password,
      async restart() {
        await killServer();
        await startServer();
      },
      rssMb,
    };
  }

  const report = await runLoadTest(ctl, {
    players,
    seats,
    targetScore: score,
    restartAfterMoves,
    thinkMs: think,
    announcements: 10,
    timeoutMs: 180_000,
    log: (l) => console.log(l),
  });
  console.log(`\n${formatReport(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await killServer();
    rmSync(dbDir, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  });
