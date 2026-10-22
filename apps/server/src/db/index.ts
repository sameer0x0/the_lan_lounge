import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
export const serverRoot = resolve(here, '../..');

export function openDb(path: string) {
  const file = path === ':memory:' ? path : resolve(serverRoot, '../..', path);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(serverRoot, 'drizzle') });
  return { db, sqlite, file };
}

export type Db = ReturnType<typeof openDb>['db'];
