import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { auditLog, players, sessions } from './db/schema.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PlayerRow = typeof players.$inferSelect;

export const findPlayerByPhone = (db: Db, phone: string) =>
  db.select().from(players).where(eq(players.phone, phone)).get();

export const findPlayerById = (db: Db, id: number) => db.select().from(players).where(eq(players.id, id)).get();

/** Display names are unique for the night, ignoring case. */
export const nameTaken = (db: Db, name: string, exceptId?: number) => {
  const row = db.select({ id: players.id }).from(players).where(sql`lower(${players.name}) = lower(${name})`).get();
  return !!row && row.id !== exceptId;
};

/** PINs are a casual guard (party Wi-Fi), but still stored salted + hashed, never in clear. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pin, salt, 32).toString('hex')}`;
}
export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const given = scryptSync(pin, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(given, Buffer.from(hash, 'hex'));
}

export function setPin(db: Db, playerId: number, pin: string | null) {
  db.update(players).set({ pinHash: pin ? hashPin(pin) : null }).where(eq(players.id, playerId)).run();
}

export function createPlayer(db: Db, v: { phone: string; name: string; avatar: string | null }) {
  return db.insert(players).values(v).returning().get();
}

/** One session per account: logging in anywhere replaces whatever was there before. */
export function startSession(db: Db, playerId: number) {
  db.delete(sessions).where(eq(sessions.playerId, playerId)).run();
  const token = randomBytes(24).toString('base64url');
  const now = Date.now();
  db.insert(sessions).values({ token, playerId, createdAt: now, expiresAt: now + SESSION_TTL_MS }).run();
  return token;
}

export function playerForToken(db: Db, token: string | undefined): PlayerRow | undefined {
  if (!token) return undefined;
  const row = db
    .select({ player: players })
    .from(sessions)
    .innerJoin(players, eq(players.id, sessions.playerId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, Date.now())))
    .get();
  return row?.player;
}

export function endSession(db: Db, token: string) {
  db.delete(sessions).where(eq(sessions.token, token)).run();
}

export function touch(db: Db, playerId: number) {
  db.update(players).set({ lastSeen: Date.now() }).where(eq(players.id, playerId)).run();
}

export function audit(db: Db, actor: string, action: string, payload?: unknown) {
  db.insert(auditLog)
    .values({ actor, action, payloadJson: payload === undefined ? null : JSON.stringify(payload) })
    .run();
}
