import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncPayload } from '@party/shared';
import { once, startServer } from './helpers.test-util.js';

let t: Awaited<ReturnType<typeof startServer>>;
beforeEach(async () => void (t = await startServer()));
afterEach(() => t.stop());

describe('join / login', () => {
  it('asks for a name for a new number, then creates the account and sets a cookie', async () => {
    const first = await t.join({ phone: '07700 900123' });
    expect(first.json).toEqual({ status: 'needName' });
    expect(first.cookie).toBeUndefined();

    const created = await t.join({ phone: '07700 900123', name: 'Rafi', avatar: '🦊' });
    expect(created.json).toMatchObject({ status: 'created', me: { name: 'Rafi', avatar: '🦊', hasPin: false } });
    expect(created.cookie).toMatch(/^pn_session=/);
  });

  it('treats different formats of the same number as the same account', async () => {
    const a = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const b = await t.join({ phone: '+44 7700 900123' });
    expect(b.json).toMatchObject({ status: 'welcomeBack', me: { name: 'Rafi' } });
    expect((b.json as any).me.id).toBe((a.json as any).me.id);
  });

  it('rejects bad numbers and duplicate names (case-insensitive)', async () => {
    expect((await t.join({ phone: 'abc' })).res.status).toBe(400);
    await t.join({ phone: '07700 900123', name: 'Rafi' });
    expect((await t.join({ phone: '07700 900124', name: 'rafi' })).res.status).toBe(409);
  });

  it('/api/me works with the cookie and 401s without', async () => {
    const { cookie } = await t.join({ phone: '07700 900123', name: 'Rafi' });
    expect((await fetch(`${t.base}/api/me`, { headers: { cookie: cookie! } })).status).toBe(200);
    expect((await fetch(`${t.base}/api/me`)).status).toBe(401);
  });
});

describe('PIN', () => {
  it('can be set at sign-up, is then required, and the right PIN gets you in', async () => {
    const created = await t.join({ phone: '07700 900123', name: 'Rafi', pin: '4821' });
    expect((created.json as any).me.hasPin).toBe(true);

    expect((await t.join({ phone: '07700 900123' })).json).toEqual({ status: 'needPin' });
    const wrong = await t.join({ phone: '07700 900123', pin: '0000' });
    expect(wrong.res.status).toBe(401);
    expect(wrong.cookie).toBeUndefined();
    const right = await t.join({ phone: '07700 900123', pin: '4821' });
    expect(right.json).toMatchObject({ status: 'welcomeBack' });
    expect(right.cookie).toBeDefined();
  });

  it('is stored hashed, never in clear', async () => {
    await t.join({ phone: '07700 900123', name: 'Rafi', pin: '4821' });
    const row = t.db.$client.prepare('select pin_hash from players').get() as { pin_hash: string };
    expect(row.pin_hash).not.toContain('4821');
    expect(row.pin_hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('locks after 5 wrong tries, even for the right PIN', async () => {
    await t.join({ phone: '07700 900123', name: 'Rafi', pin: '4821' });
    for (let i = 0; i < 5; i++) await t.join({ phone: '07700 900123', pin: '0000' });
    expect((await t.join({ phone: '07700 900123', pin: '4821' })).res.status).toBe(429);
  });

  it('rejects malformed PINs', async () => {
    expect((await t.join({ phone: '07700 900123', name: 'Rafi', pin: '12' })).res.status).toBe(400);
  });

  it('can be set, changed and removed while signed in', async () => {
    const { cookie } = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const h = { cookie: cookie! };
    expect((await t.post('/api/pin', { pin: '1234' }, h)).json.me.hasPin).toBe(true);
    expect((await t.join({ phone: '07700 900123' })).json).toEqual({ status: 'needPin' });
    expect((await t.post('/api/pin', { pin: 'abcd' }, h)).res.status).toBe(400);
    expect((await t.post('/api/pin', { pin: null }, h)).json.me.hasPin).toBe(false);
    expect((await t.join({ phone: '07700 900123' })).json).toMatchObject({ status: 'welcomeBack' });
    expect((await t.post('/api/pin', { pin: '1234' })).res.status).toBe(401);
  });
});

describe('sockets', () => {
  it('rejects sockets without a valid session', async () => {
    const s = t.open();
    const err = await new Promise<Error>((r) => s.once('connect_error', r));
    expect(err.message).toBe('unauthorized');
  });

  it('sends a full sync on connect, with no phone numbers', async () => {
    const { cookie } = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const s = t.open(cookie);
    const sync = await once<SyncPayload>(s, 'sync');
    expect(sync.me.name).toBe('Rafi');
    expect(sync.players).toEqual([expect.objectContaining({ name: 'Rafi', online: true })]);
    expect(JSON.stringify(sync)).not.toContain('7700');
  });

  it('reconnecting with the same cookie lands in the same account (no re-login)', async () => {
    const { cookie } = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const first = t.open(cookie);
    const a = await once<SyncPayload>(first, 'sync');
    first.close();
    const second = t.open(cookie);
    const b = await once<SyncPayload>(second, 'sync');
    expect(b.me.id).toBe(a.me.id);
  });

  it('shows others as online/away in lobby updates', async () => {
    const rafi = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const nadia = await t.join({ phone: '07700 900124', name: 'Nadia' });
    const r = t.open(rafi.cookie);
    await once(r, 'sync');
    const update = new Promise<any[]>((res) => r.on('lobby:update', (p) => p.find((x) => x.name === 'Nadia')?.online && res(p)));
    const n = t.open(nadia.cookie);
    await once(n, 'sync');
    expect((await update).find((x) => x.name === 'Nadia').online).toBe(true);
    const away = new Promise<any[]>((res) => r.on('lobby:update', (p) => !p.find((x) => x.name === 'Nadia')?.online && res(p)));
    n.close();
    expect((await away).find((x) => x.name === 'Nadia').online).toBe(false);
  });

  it('logging in on a second device kicks the first and invalidates its cookie', async () => {
    const phone1 = await t.join({ phone: '07700 900123', name: 'Rafi' });
    const s1 = t.open(phone1.cookie);
    await once(s1, 'sync');
    const kicked = once<{ reason: string }>(s1, 'kicked');

    const phone2 = await t.join({ phone: '07700 900123' });
    expect(await kicked).toEqual({ reason: 'otherDevice' });
    expect((await fetch(`${t.base}/api/me`, { headers: { cookie: phone1.cookie! } })).status).toBe(401);
    expect((await fetch(`${t.base}/api/me`, { headers: { cookie: phone2.cookie! } })).status).toBe(200);
  });
});
