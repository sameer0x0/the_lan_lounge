import { existsSync } from 'node:fs';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { desc, eq } from 'drizzle-orm';
import {
  ADMIN_COOKIE,
  ANNOUNCE_MAX,
  NAME_MAX,
  PIN_PATTERN,
  SESSION_COOKIE,
  UNO_COLORS,
  UnoError,
  callUno,
  catchUno,
  challengeDrawFour,
  drawCard,
  nextUnoRound,
  normalizePhone,
  passTurn,
  playCard,
  skipTurn,
  unoViewFor,
  type AdminPlayer,
  type AdminResult,
  type AdminState,
  type AuditEntry,
  type ClientToServerEvents,
  type JoinRequest,
  type JoinResponse,
  type KickReason,
  type Me,
  type PlayerPublic,
  type ServerToClientEvents,
  type UnoPayload,
  type UnoSeat,
  type UnoState,
} from '@party/shared';
import { AdminSessions, Throttle, isLocalAddress, looksProxied, passwordMatches } from './admin.js';
import {
  SESSION_TTL_MS,
  audit,
  createPlayer,
  endSession,
  findPlayerById,
  findPlayerByPhone,
  hashPin,
  nameTaken,
  playerForToken,
  setPin,
  startSession,
  touch,
  verifyPin,
  type PlayerRow,
} from './auth.js';
import type { Db } from './db/index.js';
import { auditLog, players, sessions } from './db/schema.js';
import { UnoManager } from './uno-manager.js';

interface SocketData {
  playerId?: number;
  isAdmin?: boolean;
}
type PartySocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface AppOptions {
  db: Db;
  /** Built web app to serve. Omit in tests / when using the Vite dev server. */
  webDist?: string;
  logger?: boolean;
  /** Admin is disabled entirely until this is set (from ADMIN_PASSWORD). */
  adminPassword?: string;
  /** Let /admin be reached from other devices. Off by default. */
  allowRemoteAdmin?: boolean;
  /** Addresses guests can open, shown in the QR / TV mode. */
  joinUrls?: string[];
  wifi?: { ssid?: string; password?: string };
  /** Tests only: lets a test fake a remote client with X-Forwarded-For. */
  trustProxy?: boolean;
}

const ok = (): AdminResult => ({ ok: true });
const fail = (error: string): AdminResult => ({ ok: false, error });

export async function buildApp(opts: AppOptions) {
  const { db, webDist, logger = false, adminPassword, allowRemoteAdmin = false, joinUrls = [], wifi = {} } = opts;
  const app = Fastify({ logger: logger ? { level: 'info' } : false, trustProxy: opts.trustProxy ?? false });
  await app.register(fastifyCookie);

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(app.server, {
    cors: { origin: true, credentials: true },
  });

  const adminSessions = new AdminSessions();
  const adminThrottle = new Throttle();
  const pinThrottle = new Throttle();
  const isLocal = (ip: string | undefined, local: string | undefined, headers: Record<string, string | string[] | undefined>) =>
    allowRemoteAdmin || (isLocalAddress(ip, local) && !looksProxied(headers));

  // ---- presence & lobby ---------------------------------------------------
  const sockets = new Map<number, Set<string>>(); // playerId -> live socket ids

  const toPublic = (p: PlayerRow): PlayerPublic => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    online: (sockets.get(p.id)?.size ?? 0) > 0,
  });
  const toMe = (p: PlayerRow): Me => ({ ...toPublic(p), points: p.points, hasPin: !!p.pinHash });
  const toAdminPlayer = (p: PlayerRow): AdminPlayer => ({
    ...toPublic(p),
    phone: p.phone,
    banned: p.banned,
    hasPin: !!p.pinHash,
    points: p.points,
    lastSeen: p.lastSeen,
    createdAt: p.createdAt,
  });

  const lobby = (): PlayerPublic[] =>
    db.select().from(players).where(eq(players.banned, false)).orderBy(desc(players.lastSeen)).all().map(toPublic);

  // ---- UNO table ----------------------------------------------------------
  const uno = new UnoManager(db);
  uno.restore();

  const unoSeats = (state: UnoState): UnoSeat[] =>
    state.players.map((p) => {
      const row = findPlayerById(db, Number(p.id));
      return { id: p.id, name: row?.name ?? 'Unknown', avatar: row?.avatar ?? null, online: (sockets.get(Number(p.id))?.size ?? 0) > 0 };
    });

  /** Seated players get their own view; everyone else gets null. Never the raw state. */
  function unoPayloadFor(playerId: number): UnoPayload | null {
    const state = uno.table?.state;
    if (!state || !state.players.some((p) => p.id === String(playerId))) return null;
    return { view: unoViewFor(state, String(playerId)), seats: unoSeats(state) };
  }

  function pushUno() {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.playerId !== undefined) s.emit('uno:state', unoPayloadFor(s.data.playerId));
    }
  }

  /** After any table change: tell the phones and the admin, and log round / game endings. */
  function unoChanged(before: UnoState | null, after: UnoState | null) {
    if (before && after && before.phase !== after.phase) {
      if (after.phase === 'roundOver') record('system', 'uno_round_over', { winner: after.roundWinnerId, points: after.roundPoints });
      if (after.phase === 'gameOver') record('system', 'uno_game_over', { winner: after.gameWinnerId });
    }
    pushUno();
    pushAdmin();
  }

  function adminState(): AdminState {
    const log: AuditEntry[] = db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(150)
      .all()
      .map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        payload: r.payloadJson ? JSON.parse(r.payloadJson) : null,
        createdAt: r.createdAt,
      }));
    return {
      players: db.select().from(players).orderBy(desc(players.lastSeen)).all().map(toAdminPlayer),
      audit: log,
      system: { joinUrls, wifi, connected: sockets.size, localOnly: !allowRemoteAdmin },
      uno: uno.table ? { state: uno.table.state, seats: unoSeats(uno.table.state) } : null,
    };
  }
  const pushAdmin = () => void io.to('admin').emit('admin:state', adminState());

  /** Every notable action goes through here so the audit log and the admin screen stay current. */
  function record(actor: string, action: string, payload?: unknown) {
    audit(db, actor, action, payload);
    pushAdmin();
  }

  function broadcastLobby() {
    io.emit('lobby:update', lobby());
    pushUno(); // seat online dots
    pushAdmin();
  }

  function kickPlayer(playerId: number, reason: KickReason) {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.playerId === playerId) {
        s.emit('kicked', { reason });
        s.disconnect(true);
      }
    }
  }

  // ---- guards -------------------------------------------------------------
  // The admin page and API only exist for the host machine (unless explicitly opened up).
  app.addHook('onRequest', async (req, reply) => {
    const isAdminPage = req.url === '/admin' || req.url.startsWith('/admin/') || req.url.startsWith('/admin?');
    const isAdminApi = req.url.startsWith('/api/admin');
    if (!isAdminPage && !isAdminApi) return;
    if (!isLocal(req.ip, req.socket.localAddress, req.headers)) {
      return isAdminPage
        ? reply.code(404).send({ error: 'not found' })
        : reply.code(403).send({ error: 'Admin is only available on the host laptop' });
    }
    if (isAdminApi && !adminPassword) {
      return reply.code(503).send({ error: 'Set ADMIN_PASSWORD in .env and restart the server' });
    }
  });

  const requireAdmin = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!adminSessions.valid(req.cookies[ADMIN_COOKIE])) return reply.code(401).send({ error: 'Not signed in' });
  };

  // ---- HTTP: accounts -----------------------------------------------------
  const setSessionCookie = (reply: { setCookie: Function }, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });

  app.get('/api/health', async () => ({ ok: true, time: Date.now() }));

  app.post<{ Body: JoinRequest }>('/api/join', async (req, reply) => {
    const phone = normalizePhone(req.body?.phone ?? '');
    if (!phone) return reply.code(400).send({ error: 'Enter a valid phone number' });
    const pin = req.body.pin?.trim();

    let player = findPlayerByPhone(db, phone);
    let status: 'created' | 'welcomeBack' = 'welcomeBack';

    if (!player) {
      const name = (req.body.name ?? '').trim();
      if (!name) return { status: 'needName' } satisfies JoinResponse;
      if (name.length > NAME_MAX) return reply.code(400).send({ error: `Name must be ${NAME_MAX} characters or fewer` });
      if (nameTaken(db, name)) return reply.code(409).send({ error: 'That name is taken tonight, pick another' });
      if (pin && !PIN_PATTERN.test(pin)) return reply.code(400).send({ error: 'PIN must be 4 digits' });
      const avatar = req.body.avatar?.trim().slice(0, 8) || null;
      player = createPlayer(db, { phone, name, avatar });
      if (pin) setPin(db, player.id, pin);
      player = findPlayerById(db, player.id)!;
      status = 'created';
    } else if (player.banned) {
      return reply.code(403).send({ error: 'You are not allowed in tonight' });
    } else if (player.pinHash) {
      const key = String(player.id);
      if (!pin) return { status: 'needPin' } satisfies JoinResponse;
      if (pinThrottle.locked(key)) return reply.code(429).send({ error: 'Too many wrong PINs, wait a minute' });
      if (!verifyPin(pin, player.pinHash)) {
        pinThrottle.fail(key);
        record(`player:${player.id}`, 'pin_failed');
        return reply.code(401).send({ error: 'Wrong PIN' });
      }
      pinThrottle.clear(key);
    }

    const token = startSession(db, player.id);
    kickPlayer(player.id, 'otherDevice'); // their previous session is gone
    touch(db, player.id);
    setSessionCookie(reply, token);
    record(`player:${player.id}`, status === 'created' ? 'join' : 'login');
    broadcastLobby();
    return { status, me: toMe(player) } satisfies JoinResponse;
  });

  app.get('/api/me', async (req, reply) => {
    const player = playerForToken(db, req.cookies[SESSION_COOKIE]);
    if (!player || player.banned) return reply.code(401).send({ error: 'Not signed in' });
    return { me: toMe(player) };
  });

  /** Set, change or (with null) remove your own PIN. */
  app.post<{ Body: { pin: string | null } }>('/api/pin', async (req, reply) => {
    const player = playerForToken(db, req.cookies[SESSION_COOKIE]);
    if (!player || player.banned) return reply.code(401).send({ error: 'Not signed in' });
    const pin = req.body?.pin;
    if (pin !== null && !(typeof pin === 'string' && PIN_PATTERN.test(pin))) {
      return reply.code(400).send({ error: 'PIN must be 4 digits' });
    }
    setPin(db, player.id, pin);
    record(`player:${player.id}`, pin ? 'pin_set' : 'pin_removed');
    return { me: toMe(findPlayerById(db, player.id)!) };
  });

  app.post('/api/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) endSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- HTTP: admin --------------------------------------------------------
  app.post<{ Body: { password: string } }>('/api/admin/login', async (req, reply) => {
    const key = req.ip;
    if (adminThrottle.locked(key)) return reply.code(429).send({ error: 'Too many tries, wait a minute' });
    if (!passwordMatches(req.body?.password ?? '', adminPassword!)) {
      adminThrottle.fail(key);
      record('admin', 'admin_login_failed', { ip: req.ip });
      return reply.code(401).send({ error: 'Wrong password' });
    }
    adminThrottle.clear(key);
    reply.setCookie(ADMIN_COOKIE, adminSessions.start(), { httpOnly: true, sameSite: 'strict', path: '/' });
    record('admin', 'admin_login');
    return { ok: true };
  });

  app.get('/api/admin/me', { preHandler: requireAdmin }, async () => ({ ok: true }));

  app.post('/api/admin/logout', async (req, reply) => {
    adminSessions.end(req.cookies[ADMIN_COOKIE]);
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- realtime -----------------------------------------------------------
  io.use((socket, next) => {
    const cookies = app.parseCookie(socket.handshake.headers.cookie ?? '');
    const player = playerForToken(db, cookies[SESSION_COOKIE]);
    const isAdmin =
      !!adminPassword &&
      adminSessions.valid(cookies[ADMIN_COOKIE]) &&
      isLocal(socket.handshake.address, socket.request.socket.localAddress, socket.handshake.headers);
    const validPlayer = player && !player.banned ? player : undefined;
    if (!validPlayer && !isAdmin) return next(new Error('unauthorized'));
    socket.data.playerId = validPlayer?.id;
    socket.data.isAdmin = isAdmin;
    next();
  });

  io.on('connection', (socket: PartySocket) => {
    const { playerId, isAdmin } = socket.data;

    // Anything shaped like an admin command from a non-admin socket is dropped and logged.
    socket.onAny((event: string) => {
      if (event.startsWith('admin:') && !isAdmin) {
        record(playerId ? `player:${playerId}` : 'unknown', 'admin_rejected', { event });
      }
    });

    if (isAdmin) registerAdmin(socket);

    if (playerId !== undefined) {
      let set = sockets.get(playerId);
      if (!set) sockets.set(playerId, (set = new Set()));
      set.add(socket.id);
      touch(db, playerId);

      // Full resync: everything a reconnecting phone needs to render from scratch.
      const me = findPlayerById(db, playerId)!;
      socket.emit('sync', { serverTime: Date.now(), me: toMe(me), players: lobby(), uno: unoPayloadFor(playerId) });
      broadcastLobby();

      socket.on('ping', (cb) => cb(Date.now()));

      /** One UNO move: the engine checks seat, turn and legality; its message becomes the ack error. */
      const unoMove = (move: (state: UnoState, me: string) => UnoState, cb?: (r: AdminResult) => void) => {
        try {
          const { before, after } = uno.apply((state) => move(state, String(playerId)));
          unoChanged(before, after);
          cb?.(ok());
        } catch (e) {
          if (!(e instanceof UnoError) && !(e instanceof Error && e.message === 'No UNO game is running')) app.log.error(e);
          cb?.(fail(e instanceof UnoError || (e instanceof Error && e.message === 'No UNO game is running') ? e.message : 'Something went wrong'));
        }
      };

      socket.on('uno:play', (p, cb) => {
        if (!p || !Number.isInteger(p.cardId)) return cb?.(fail('Invalid card'));
        if (p.color !== undefined && !UNO_COLORS.includes(p.color)) return cb?.(fail('Invalid colour'));
        unoMove((s, me) => playCard(s, me, p.cardId, p.color), cb);
      });
      socket.on('uno:draw', (cb) => unoMove((s, me) => drawCard(s, me), cb));
      socket.on('uno:pass', (cb) => unoMove((s, me) => passTurn(s, me), cb));
      socket.on('uno:callUno', (cb) => unoMove((s, me) => callUno(s, me), cb));
      socket.on('uno:catch', (cb) => unoMove((s, me) => catchUno(s, me), cb));
      socket.on('uno:challenge', (cb) => unoMove((s, me) => challengeDrawFour(s, me), cb));

      socket.on('disconnect', () => {
        const live = sockets.get(playerId);
        live?.delete(socket.id);
        if (live?.size === 0) sockets.delete(playerId);
        touch(db, playerId);
        broadcastLobby();
      });
    }
  });

  function registerAdmin(socket: PartySocket) {
    void socket.join('admin');
    socket.emit('admin:state', adminState());

    /** Runs one admin command, turns exceptions into a failed ack, and logs successes. */
    const command =
      <P>(action: string, run: (p: P) => AdminResult) =>
      (p: P, cb?: (r: AdminResult) => void) => {
        let result: AdminResult;
        try {
          result = run(p);
        } catch (e) {
          result = fail((e as Error).message);
        }
        if (result.ok) record('admin', action, p);
        cb?.(result);
      };

    const target = (id: number) => findPlayerById(db, id);

    socket.on(
      'admin:kick',
      command<{ playerId: number }>('kick', ({ playerId }) => {
        const p = target(playerId);
        if (!p) return fail('No such player');
        db.delete(sessions).where(eq(sessions.playerId, playerId)).run();
        kickPlayer(playerId, 'admin');
        broadcastLobby();
        return ok();
      }),
    );

    socket.on(
      'admin:ban',
      command<{ playerId: number; banned: boolean }>('ban', ({ playerId, banned }) => {
        if (!target(playerId)) return fail('No such player');
        db.update(players).set({ banned }).where(eq(players.id, playerId)).run();
        if (banned) {
          db.delete(sessions).where(eq(sessions.playerId, playerId)).run();
          kickPlayer(playerId, 'banned');
        }
        broadcastLobby();
        return ok();
      }),
    );

    socket.on(
      'admin:rename',
      command<{ playerId: number; name: string }>('rename', ({ playerId, name }) => {
        const clean = (name ?? '').trim();
        if (!target(playerId)) return fail('No such player');
        if (!clean || clean.length > NAME_MAX) return fail(`Name must be 1-${NAME_MAX} characters`);
        if (nameTaken(db, clean, playerId)) return fail('That name is taken');
        db.update(players).set({ name: clean }).where(eq(players.id, playerId)).run();
        broadcastLobby();
        return ok();
      }),
    );

    socket.on(
      'admin:resetPin',
      command<{ playerId: number }>('reset_pin', ({ playerId }) => {
        if (!target(playerId)) return fail('No such player');
        setPin(db, playerId, null);
        pinThrottle.clear(String(playerId));
        pushAdmin();
        return ok();
      }),
    );

    socket.on(
      'admin:broadcast',
      command<{ text: string }>('broadcast', ({ text }) => {
        const clean = (text ?? '').trim();
        if (!clean) return fail('Write something first');
        if (clean.length > ANNOUNCE_MAX) return fail(`Keep it under ${ANNOUNCE_MAX} characters`);
        io.emit('announce', { id: randomUUID(), text: clean });
        return ok();
      }),
    );
    socket.on(
      'admin:unoCreate',
      command<{ playerIds: number[]; targetScore?: number }>('uno_create', ({ playerIds, targetScore }) => {
        if (!Array.isArray(playerIds) || !playerIds.every(Number.isInteger) || new Set(playerIds).size !== playerIds.length) {
          return fail('Pick the players to seat');
        }
        for (const id of playerIds) {
          const p = target(id);
          if (!p || p.banned) return fail('One of those players is not available');
        }
        if (targetScore !== undefined && !(Number.isInteger(targetScore) && targetScore > 0)) return fail('Target score must be a positive number');
        try {
          uno.create(playerIds, targetScore);
        } catch (e) {
          if (e instanceof UnoError) return fail(e.message);
          throw e;
        }
        unoChanged(null, uno.table!.state);
        return ok();
      }),
    );

    /** Wraps an admin action on the live table: engine errors become the ack message. */
    const tableCommand = (action: string, move: (s: UnoState) => UnoState) =>
      command<undefined>(action, () => {
        try {
          const { before, after } = uno.apply(move);
          unoChanged(before, after);
          return ok();
        } catch (e) {
          if (e instanceof UnoError) return fail(e.message);
          throw e;
        }
      });
    socket.on('admin:unoSkip', (cb) => tableCommand('uno_skip', (s) => skipTurn(s))(undefined, cb));
    socket.on('admin:unoNextRound', (cb) => tableCommand('uno_next_round', (s) => nextUnoRound(s))(undefined, cb));
    socket.on('admin:unoEnd', (cb) =>
      command<undefined>('uno_end', () => {
        if (!uno.table) return fail('No UNO game is running');
        uno.end();
        unoChanged(null, null);
        return ok();
      })(undefined, cb),
    );
  }

  // ---- static web app -----------------------------------------------------
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    // SPA fallback so /join, /admin etc. load the React app on refresh.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return { app, io, kickPlayer, broadcastLobby, record, uno, unoChanged };
}
