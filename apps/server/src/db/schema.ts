import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const now = () => Date.now();

export const players = sqliteTable('players', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phone: text('phone').notNull().unique(),
  name: text('name').notNull().unique(),
  avatar: text('avatar'),
  pinHash: text('pin_hash'),
  points: integer('points').notNull().default(0),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().$defaultFn(now),
  lastSeen: integer('last_seen').notNull().$defaultFn(now),
});

export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  playerId: integer('player_id').notNull().references(() => players.id),
  createdAt: integer('created_at').notNull().$defaultFn(now),
  expiresAt: integer('expires_at').notNull(),
});

export const dares = sqliteTable('dares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  intensity: text('intensity', { enum: ['mild', 'spicy', 'chaos'] }).notNull().default('mild'),
  points: integer('points').notNull().default(10),
  timerS: integer('timer_s'),
  usesSecondPlayer: integer('uses_second_player', { mode: 'boolean' }).notNull().default(false),
  oneTime: integer('one_time', { mode: 'boolean' }).notNull().default(false),
  used: integer('used', { mode: 'boolean' }).notNull().default(false),
});

export const dareRounds = sqliteTable('dare_rounds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dareId: integer('dare_id').notNull().references(() => dares.id),
  playerId: integer('player_id').notNull().references(() => players.id),
  secondPlayerId: integer('second_player_id').references(() => players.id),
  outcome: text('outcome', { enum: ['done', 'chickened', 'rerolled'] }),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});

export const games = sqliteTable('games', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['uno'] }).notNull(),
  status: text('status').notNull().default('lobby'),
  settingsJson: text('settings_json').notNull().default('{}'),
  stateJson: text('state_json'),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  payloadJson: text('payload_json'),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});
