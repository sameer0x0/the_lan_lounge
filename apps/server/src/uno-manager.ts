import { desc, eq } from 'drizzle-orm';
import { createUnoGame, type UnoState } from '@party/shared';
import type { Db } from './db/index.js';
import { games } from './db/schema.js';

/**
 * Owns the one live UNO table (v1 runs a single table; `id` is the games row so several can come later).
 * Every change is written to SQLite straight away, so a server restart picks the game up mid-hand.
 * `games.status`: 'playing' = the table is on screen (including between rounds and after game over),
 * 'ended' = the host closed it.
 */
export class UnoManager {
  table: { id: number; state: UnoState } | null = null;

  constructor(private db: Db) {}

  /** Reload the table that was live when the server last stopped. Corrupt data is ignored, not fatal. */
  restore() {
    const row = this.db.select().from(games).where(eq(games.status, 'playing')).orderBy(desc(games.id)).get();
    if (!row || row.type !== 'uno' || !row.stateJson) return;
    try {
      this.table = { id: row.id, state: JSON.parse(row.stateJson) as UnoState };
    } catch {
      this.table = null;
    }
  }

  /** Seats the given players and deals. Closes any table that was already open. */
  create(playerIds: readonly number[], targetScore?: number): UnoState {
    const state = createUnoGame(playerIds.map(String), targetScore === undefined ? {} : { targetScore });
    this.end();
    const row = this.db
      .insert(games)
      .values({
        type: 'uno',
        status: 'playing',
        settingsJson: JSON.stringify(state.settings),
        stateJson: JSON.stringify(state),
      })
      .returning()
      .get();
    this.table = { id: row.id, state };
    return state;
  }

  /** Runs one engine action on the live table and saves the result. Engine errors propagate untouched. */
  apply(action: (state: UnoState) => UnoState): { before: UnoState; after: UnoState } {
    if (!this.table) throw new Error('No UNO game is running');
    const before = this.table.state;
    const after = action(before);
    this.table.state = after;
    this.db.update(games).set({ stateJson: JSON.stringify(after) }).where(eq(games.id, this.table.id)).run();
    return { before, after };
  }

  end() {
    if (!this.table) return;
    this.db.update(games).set({ status: 'ended' }).where(eq(games.id, this.table.id)).run();
    this.table = null;
  }
}
