/** Everything about the wire contract between phones, the admin console and the server. Keep docs/API.md in sync. */
import type { UnoColor, UnoState, UnoView } from './uno';

/** What other players may see about someone. Never includes the phone number. */
export interface PlayerPublic {
  id: number;
  name: string;
  avatar: string | null;
  online: boolean;
}

/** The signed-in player's own view of themselves. */
export interface Me extends PlayerPublic {
  points: number;
  hasPin: boolean;
}

/** Someone sitting at the UNO table. Engine player ids are `String(player.id)`. */
export interface UnoSeat {
  id: string;
  name: string;
  avatar: string | null;
  online: boolean;
}

/** A seated player's whole UNO screen: their own view plus who is who. */
export interface UnoPayload {
  view: UnoView;
  seats: UnoSeat[];
}

export interface SyncPayload {
  serverTime: number;
  me: Me;
  players: PlayerPublic[];
  /** The player's UNO table, or null when they aren't seated. */
  uno: UnoPayload | null;
}

export type KickReason = 'otherDevice' | 'admin' | 'banned';

export interface Announcement {
  id: string;
  text: string;
}

// ---- admin ---------------------------------------------------------------

/** The host sees everything, including phone numbers. Only ever sent to admin sockets. */
export interface AdminPlayer extends PlayerPublic {
  phone: string;
  banned: boolean;
  hasPin: boolean;
  points: number;
  lastSeen: number;
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  payload: unknown;
  createdAt: number;
}

export interface AdminSystem {
  /** URLs guests can type or scan, e.g. http://192.168.0.10:3000 */
  joinUrls: string[];
  wifi: { ssid?: string; password?: string };
  /** Players with a live socket right now. */
  connected: number;
  /** True when /admin only accepts requests from the host machine. */
  localOnly: boolean;
}

export interface AdminState {
  players: AdminPlayer[];
  audit: AuditEntry[];
  system: AdminSystem;
  /** The live UNO table with EVERY hand (god mode). Admin sockets only. */
  uno: { state: UnoState; seats: UnoSeat[] } | null;
}

export type AdminResult = { ok: true } | { ok: false; error: string };
type Ack = (result: AdminResult) => void;

export interface ServerToClientEvents {
  /** Full state, sent on every (re)connect. */
  sync: (payload: SyncPayload) => void;
  'lobby:update': (players: PlayerPublic[]) => void;
  kicked: (payload: { reason: KickReason }) => void;
  /** Host banner shown on every phone. */
  announce: (payload: Announcement) => void;
  /** Seated players only get their table; everyone else gets null (also sent when the table ends). */
  'uno:state': (payload: UnoPayload | null) => void;
  /** Admin sockets only. Pushed on connect and after every change. */
  'admin:state': (state: AdminState) => void;
}

export interface ClientToServerEvents {
  ping: (cb: (serverTime: number) => void) => void;
  // UNO moves. The server checks seat, turn and legality; the ack says why a move was refused.
  'uno:play': (p: { cardId: number; color?: UnoColor }, cb: Ack) => void;
  'uno:draw': (cb: Ack) => void;
  'uno:pass': (cb: Ack) => void;
  'uno:callUno': (cb: Ack) => void;
  'uno:catch': (cb: Ack) => void;
  'uno:challenge': (cb: Ack) => void;
  // Admin sockets only. Anything else sending admin:* is ignored and logged.
  'admin:kick': (p: { playerId: number }, cb: Ack) => void;
  'admin:ban': (p: { playerId: number; banned: boolean }, cb: Ack) => void;
  'admin:rename': (p: { playerId: number; name: string }, cb: Ack) => void;
  'admin:resetPin': (p: { playerId: number }, cb: Ack) => void;
  'admin:broadcast': (p: { text: string }, cb: Ack) => void;
  'admin:unoCreate': (p: { playerIds: number[]; targetScore?: number }, cb: Ack) => void;
  'admin:unoSkip': (cb: Ack) => void;
  'admin:unoNextRound': (cb: Ack) => void;
  'admin:unoEnd': (cb: Ack) => void;
}

// ---- HTTP ----------------------------------------------------------------

// POST /api/join
export interface JoinRequest {
  phone: string;
  name?: string;
  avatar?: string;
  /** Required for accounts that have a PIN. Optional when creating one. */
  pin?: string;
}
export type JoinResponse =
  | { status: 'needName' }
  | { status: 'needPin' }
  | { status: 'created' | 'welcomeBack'; me: Me };

export const SESSION_COOKIE = 'pn_session';
export const ADMIN_COOKIE = 'pn_admin';
export const NAME_MAX = 20;
export const PIN_PATTERN = /^\d{4}$/;
export const ANNOUNCE_MAX = 200;
