import { io as connect, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import type { ClientToServerEvents, JoinResponse, ServerToClientEvents } from '@party/shared';
import { buildApp, type AppOptions } from './app.js';
import { openDb } from './db/index.js';

export type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Pass `db` to start a second server on the same database (restart tests). */
export async function startServer(extra: Partial<AppOptions> = {}) {
  const db = extra.db ?? openDb(':memory:').db;
  const built = await buildApp({ trustProxy: true, ...extra, db });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
  const sockets: Client[] = [];

  const post = async (path: string, body: object, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    return { res, cookie, json: (await res.json()) as any };
  };

  return {
    ...built,
    db,
    base,
    post,
    join: async (body: object) => {
      const r = await post('/api/join', body);
      return { ...r, json: r.json as JoinResponse & { error?: string } };
    },
    open(cookie?: string): Client {
      const s: Client = connect(base, { transports: ['websocket'], extraHeaders: cookie ? { cookie } : {}, reconnection: false });
      sockets.push(s);
      return s;
    },
    async stop() {
      for (const s of sockets) s.close();
      await built.app.close();
    },
  };
}

export const once = <T>(s: Client, ev: string) => new Promise<T>((r) => (s as any).once(ev, r));
