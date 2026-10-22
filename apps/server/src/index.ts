import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { openDb, serverRoot } from './db/index.js';

// Optional .env at the repo root (see .env.example). Real environment variables win.
try {
  process.loadEnvFile(resolve(serverRoot, '../../.env'));
} catch {
  /* no .env file */
}

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? 'data/party.sqlite';
const webDist = resolve(serverRoot, '../web/dist');

const lanIps = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n!.address);
// PUBLIC_URL (comma separated) wins, e.g. http://party.lan:3000
const joinUrls = process.env.PUBLIC_URL
  ? process.env.PUBLIC_URL.split(',').map((u) => u.trim())
  : lanIps.map((ip) => `http://${ip}:${PORT}`);

const { db, file } = openDb(DB_PATH);
const { app } = await buildApp({
  db,
  webDist,
  logger: true,
  adminPassword: process.env.ADMIN_PASSWORD || undefined,
  allowRemoteAdmin: process.env.ADMIN_ALLOW_REMOTE === '1',
  joinUrls,
  wifi: { ssid: process.env.WIFI_SSID || undefined, password: process.env.WIFI_PASSWORD || undefined },
});

await app.listen({ port: PORT, host: '0.0.0.0' });

console.log(`\nParty Night is up. DB: ${file}`);
console.log(`  This machine: http://localhost:${PORT}`);
for (const url of joinUrls) console.log(`  Guests:       ${url}`);
console.log(
  process.env.ADMIN_PASSWORD
    ? `  Admin:        http://localhost:${PORT}/admin`
    : '  Admin:        DISABLED (set ADMIN_PASSWORD in .env to turn it on)',
);
console.log('');
