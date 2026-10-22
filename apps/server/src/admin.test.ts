import { afterEach, describe, expect, it } from 'vitest';
import type { AdminResult, AdminState } from '@party/shared';
import { isLocalAddress, looksProxied } from './admin.js';
import { once, startServer } from './helpers.test-util.js';

let t: Awaited<ReturnType<typeof startServer>>;
afterEach(() => t.stop());

const REMOTE = { 'x-forwarded-for': '192.168.0.55' };

async function adminCookie() {
  const login = await t.post('/api/admin/login', { password: 'hunter2' });
  return login.cookie!;
}
const ack = <P>(s: any, event: string, payload: P) => new Promise<AdminResult>((r) => s.emit(event, payload, r));
const nextState = (s: any) => once<AdminState>(s, 'admin:state');

describe('admin guard', () => {
  it('is disabled until ADMIN_PASSWORD is set', async () => {
    t = await startServer();
    expect((await t.post('/api/admin/login', { password: 'x' })).res.status).toBe(503);
  });

  it('only talks to the host machine', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    expect((await t.post('/api/admin/login', { password: 'hunter2' }, REMOTE)).res.status).toBe(403);
    expect((await fetch(`${t.base}/admin`, { headers: REMOTE })).status).toBe(404);
    expect((await t.post('/api/admin/login', { password: 'hunter2' })).res.status).toBe(200);
  });

  it('treats tunnelled traffic as remote even though it arrives from 127.0.0.1', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    const tunnel = { 'cf-connecting-ip': '203.0.113.9' };
    expect((await t.post('/api/admin/login', { password: 'hunter2' }, tunnel)).res.status).toBe(403);
    expect((await fetch(`${t.base}/admin`, { headers: tunnel })).status).toBe(404);
    // an admin cookie obtained locally is useless over the tunnel too
    const cookie = await adminCookie();
    const proxied = (await import('socket.io-client')).io(t.base, {
      transports: ['websocket'],
      extraHeaders: { cookie, 'x-forwarded-for': '203.0.113.9' },
      reconnection: false,
    });
    const err = await new Promise<Error>((r) => proxied.once('connect_error', r));
    proxied.close();
    expect(err.message).toBe('unauthorized');
  });

  it('can be opened up explicitly', async () => {
    t = await startServer({ adminPassword: 'hunter2', allowRemoteAdmin: true });
    expect((await t.post('/api/admin/login', { password: 'hunter2' }, REMOTE)).res.status).toBe(200);
  });

  it('checks the password and throttles guessing', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    expect((await t.post('/api/admin/login', { password: 'nope' })).res.status).toBe(401);
    for (let i = 0; i < 4; i++) await t.post('/api/admin/login', { password: 'nope' });
    expect((await t.post('/api/admin/login', { password: 'hunter2' })).res.status).toBe(429);
  });

  it('protects /api/admin/me with the admin cookie', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    expect((await fetch(`${t.base}/api/admin/me`)).status).toBe(401);
    const cookie = await adminCookie();
    expect((await fetch(`${t.base}/api/admin/me`, { headers: { cookie } })).status).toBe(200);
    // a player session is not an admin session
    const player = await t.join({ phone: '07700 900123', name: 'Rafi' });
    expect((await fetch(`${t.base}/api/admin/me`, { headers: { cookie: player.cookie! } })).status).toBe(401);
  });

  it('isLocalAddress: loopback and own LAN address only', () => {
    expect(isLocalAddress('127.0.0.1', '192.168.0.10')).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1', undefined)).toBe(true);
    expect(isLocalAddress('192.168.0.10', '::ffff:192.168.0.10')).toBe(true);
    expect(isLocalAddress('192.168.0.55', '192.168.0.10')).toBe(false);
    expect(looksProxied({ 'x-forwarded-for': '1.2.3.4' })).toBe(true);
    expect(looksProxied({ host: 'localhost:3000' })).toBe(false);
  });
});

describe('admin console over sockets', () => {
  it('admin socket gets state including phones; plain sockets and cookie-less sockets do not', async () => {
    t = await startServer({ adminPassword: 'hunter2', joinUrls: ['http://192.168.0.10:3000'] });
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const admin = t.open(await adminCookie());
    const state = await nextState(admin);
    expect(state.players[0]).toMatchObject({ name: 'Rafi', phone: '7700900123', banned: false });
    expect(state.system).toMatchObject({ joinUrls: ['http://192.168.0.10:3000'], localOnly: true });

    const guest = t.open(rafi.cookie);
    let leaked = false;
    guest.on('admin:state' as any, () => (leaked = true));
    await once(guest, 'sync');
    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);
    const stranger = t.open();
    expect((await new Promise<Error>((r) => stranger.once('connect_error', r))).message).toBe('unauthorized');
  });

  it('kick signs the player out of their phone but lets them rejoin', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const guest = t.open(rafi.cookie);
    const { me } = await once<any>(guest, 'sync');
    const kicked = once<{ reason: string }>(guest, 'kicked');
    const admin = t.open(await adminCookie());
    expect(await ack(admin, 'admin:kick', { playerId: me.id })).toEqual({ ok: true });
    expect(await kicked).toEqual({ reason: 'admin' });
    expect((await fetch(`${t.base}/api/me`, { headers: { cookie: rafi.cookie! } })).status).toBe(401);
    expect((await t.join({ phone: '07700 900123' })).json).toMatchObject({ status: 'welcomeBack' });
  });

  it('ban blocks sign-in until unbanned, and hides the player from the lobby', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const nadia = await t.join({ phone: '07700 900124', name: 'Nadia' });
    const admin = t.open(await adminCookie());
    const id = (rafi.json as any).me.id;
    expect(await ack(admin, 'admin:ban', { playerId: id, banned: true })).toEqual({ ok: true });
    expect((await t.join({ phone: '07700 900123' })).res.status).toBe(403);
    const sync = await once<any>(t.open(nadia.cookie), 'sync');
    expect(sync.players.map((p: any) => p.name)).toEqual(['Nadia']);
    await ack(admin, 'admin:ban', { playerId: id, banned: false });
    expect((await t.join({ phone: '07700 900123' })).json).toMatchObject({ status: 'welcomeBack' });
  });

  it('rename enforces unique names; reset PIN clears the PIN', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi', pin: '1234' });
    await t.join({ phone: '07700 900124', name: 'Nadia' });
    const admin = t.open(await adminCookie());
    const id = (rafi.json as any).me.id;
    expect(await ack(admin, 'admin:rename', { playerId: id, name: 'nadia' })).toMatchObject({ ok: false });
    expect(await ack(admin, 'admin:rename', { playerId: id, name: 'Rafi B' })).toEqual({ ok: true });
    expect((await t.join({ phone: '07700 900123' })).json).toEqual({ status: 'needPin' });
    expect(await ack(admin, 'admin:resetPin', { playerId: id })).toEqual({ ok: true });
    expect((await t.join({ phone: '07700 900123' })).json).toMatchObject({ status: 'welcomeBack', me: { name: 'Rafi B' } });
  });

  it('broadcast reaches every phone and validates the text', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const guest = t.open(rafi.cookie);
    await once(guest, 'sync');
    const banner = once<{ text: string }>(guest, 'announce');
    const admin = t.open(await adminCookie());
    expect(await ack(admin, 'admin:broadcast', { text: '  ' })).toMatchObject({ ok: false });
    expect(await ack(admin, 'admin:broadcast', { text: "Pizza's here" })).toEqual({ ok: true });
    expect((await banner).text).toBe("Pizza's here");
  });

  it('admin commands from a normal player are ignored and logged', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const nadia = await t.join({ phone: '07700 900124', name: 'Nadia' });
    const guest = t.open(rafi.cookie);
    await once(guest, 'sync');
    const nadiaId = (nadia.json as any).me.id;
    (guest as any).emit('admin:ban', { playerId: nadiaId, banned: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(t.db.$client.prepare('select banned from players where id = ?').get(nadiaId)).toEqual({ banned: 0 });
    const row = t.db.$client.prepare("select actor, payload_json from audit_log where action = 'admin_rejected'").get() as any;
    expect(row.actor).toMatch(/^player:/);
    expect(row.payload_json).toContain('admin:ban');
  });

  it('records admin actions in the audit log', async () => {
    t = await startServer({ adminPassword: 'hunter2' });
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const admin = t.open(await adminCookie());
    await nextState(admin);
    await ack(admin, 'admin:kick', { playerId: (rafi.json as any).me.id });
    const actions = (t.db.$client.prepare('select action from audit_log order by id').all() as any[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['join', 'admin_login', 'kick']));
  });
});
