# Progress

Phases come from `docs/SPEC.md` ("Build plan"). Tick a phase only when its "done when" check has passed, and add a section below saying what was built, where, and how to verify it.

- [x] 1. Skeleton
- [x] 2. Accounts + lobby
- [x] 3. Admin console (core; merge duplicates and export/wipe deferred, see below)
- [ ] 4. Dare or Dare (switched off for now, see `packages/shared/src/games.ts`)
- [x] 5. UNO engine (core rules; house rules deferred)
- [x] 6. UNO UI + admin controls (core; undo, timer, force-draw, house rules deferred)
- [~] 7. Party hardening: the 20-player load test and kill-and-restart-mid-game are **done**; old Android phone test, dark-mode polish, sounds and vibration polish remain
- [ ] Imposter: engine + tests + practice screen done; **not wired to real players/sockets yet** (needs `imposter:*` events, see below). The UNO table manager (`uno-manager.ts`) is the pattern to copy.

## Phase 1: Skeleton (done)
Monorepo (`apps/server`, `apps/web`, `packages/shared`), Fastify serves the Vite build, SQLite via Drizzle with migrations applied at boot, `npm run party`.

## Phase 2: Accounts + lobby (done)
- **Shared:** `phone.ts` (normaliser, tested), `protocol.ts` (wire types, cookie name).
- **Server:** `src/auth.ts` (player/session/audit DB helpers), `src/app.ts` (`buildApp({ db, webDist })`: routes, socket auth, presence, lobby broadcast). `src/index.ts` only opens the DB and listens. Tests build the app on an in-memory DB (`openDb(':memory:')`).
- **Web:** `Join.tsx` (phone, then name + emoji for new numbers), `App.tsx` (cookie check, home with game list + live lobby), `api.ts`, `socket.ts` (`autoConnect: false`, connected after sign-in).
- **Behaviour:** closing/reopening the tab lands back in the same account (cookie); reconnects resync via `sync`; second-device login kicks the first.
- **Verify:** `npm test` (server integration tests cover join, formats, cookie, sync, presence, kick). By hand: `npm run party`, open the printed LAN URL on two phones, join, close a tab and reopen it.
- **Done afterwards:** ban/kick/rename and the optional PIN landed in Phase 3 (below).
- **Known limits:** the "away" timeout that auto-skips a UNO turn is not built (belongs with UNO, Phase 6). `Home`'s socket effect re-runs if `App` re-renders with a new `onSignedOut`; App only re-renders on sign-in/out so this is harmless today.

## Phase 3: Admin console + PIN (done)
- **PIN:** optional 4 digits, offered at sign-up and changeable from the home screen (`PinSettings.tsx`). Server side in `auth.ts` (`hashPin`/`verifyPin`/`setPin`, scrypt) and `/api/join` + `/api/pin` in `app.ts`. Throttled (5 tries, 60 s). Host can reset it.
- **Admin server:** `src/admin.ts` (`AdminSessions`, `Throttle`, `isLocalAddress`, `passwordMatches`), admin routes and `registerAdmin()` in `app.ts`, config via env in `index.ts` (`.env` is loaded from the repo root; see `.env.example`).
- **Admin UI** (`apps/web/src/admin/`): `Admin.tsx` (login + tabs: Players, Broadcast, Audit log, System), `Tv.tsx` (QR + Wi-Fi + who's here, at `/admin/tv`), `useAdmin.ts` (admin socket + typed `send`). The QR is generated in the browser (`qrcode` package), so it works offline.
- **Phones:** announcement banner (`announce`), PIN prompts in `Join.tsx`, `kicked` handling already in `App.tsx`.
- **Imposter practice screen:** now uses the real people online (no made-up names) and needs 3+ online.
- **Verify:** `npm test` (27 server tests cover PIN, guard, kick/ban/rename/reset/broadcast, rejected admin commands, audit). By hand: copy `.env.example` to `.env`, set `ADMIN_PASSWORD`, `npm run party`, open `http://localhost:3000/admin` on the laptop, join from a phone, then try each control; open `/admin` from the phone and confirm it 404s.
- **Deferred (still in the spec's admin table):** merge duplicate accounts, export/wipe player data, adjust points, move players into games, restart game state. They belong with the games they control (Phases 4 to 6) or a later "System" pass.
- **Gotchas:** `.env.example` ships `ADMIN_PASSWORD=change-me`, so change it. The admin session lives in memory: restarting the server signs the host out (players stay signed in, they are in SQLite). Admin host check is unreliable under the Vite dev server (see `docs/API.md`).

## Phase 5: UNO engine (done)
- **Where:** `packages/shared/src/uno.ts` (pure TS, no I/O, no timers) and `uno.test.ts` (57 tests). `random.ts` now holds the shared `shuffle` / `Rng` (Imposter uses it too).
- **API (all return a NEW state or throw `UnoError` with a player-safe message):** `createUnoGame(playerIds, { targetScore }, rng)`, `playCard(state, playerId, cardId, chosenColor?, rng?)`, `drawCard`, `passTurn`, `challengeDrawFour`, `callUno`, `catchUno`, `skipTurn` (host skip / absent-player timeout), `nextUnoRound`, `legalPlays`, `isPlayable`, and `unoViewFor(state, playerId)` which is the **only** thing a phone receives (own hand + counts; never other hands or the draw pile; a Draw Four challenge does not reveal whether it was a bluff). Pass a seeded `rng` for repeatable tests.
- **Rule decisions to know about** (the spec text is ambiguous or silent here):
  - A Wild Draw Four may be played any time; the **challenge** is what punishes a bluff (bluffer = held a card of the old colour). Bluff caught: bluffer draws 4, challenger plays on. Honest: challenger draws 6 and loses the turn. Accept (`drawCard` while challenged): draw 4, lose the turn.
  - Winning with a Draw Four or Draw Two: the next player still draws, and those cards count toward the score. A winning Draw Four skips the challenge.
  - Opening card: Wild Draw Four is shuffled back; Skip skips the first player; Draw Two hits them; Reverse flips direction and the dealer starts (Skip with 2 players); an opening Wild leaves `activeColor = null` so the first player may play anything.
  - UNO: `callUno` works with 1 or 2 cards (calling with 2 pre-protects the play down to 1). Dropping to 1 without calling sets `unoPending`; `catchUno` by anyone else before the next player acts makes them draw 2. Any action by the next player closes the window.
  - Drawing: you may draw even if you hold a playable card. If the drawn card is playable you may play it (`state.drawn`) or `passTurn`; otherwise the turn ends.
  - Seat order = the order of `playerIds`; seat 0 plays first in round 1, then the dealer rotates.
- **Not built (deliberately, Phase 6):** house rules (stacking, draw-until-play, 7-0, jump-in), turn-timer scheduling, undo, force-draw, all sockets/DB/UI. State is plain JSON and immutable, so undo = keep a stack of previous states, persistence = `JSON.stringify` into `games.state_json`.
- **Verify:** `npm test -w @party/shared`. Includes 57 seeded bot games (2-20 players) that play to a winner and check every card is accounted for after every move.

## Phase 6: UNO on real phones, with image cards (core, done)
- **Card images:** original SVG art, not the official UNO design. `npm run cards` runs `scripts/generate-cards.ts` and writes 55 files (52 coloured, 2 wilds, back) to `apps/web/public/cards/`; they are committed, so `npm run party` needs no extra step. File names come from `cardAsset(card)` / `CARD_BACK` in `packages/shared/src/uno.ts`, so UI and generator can't disagree. `card-assets.test.ts` fails if a deck card has no file. To restyle, edit the generator and re-run it; to use your own artwork, replace the files keeping the names (e.g. `red-5.svg`, `blue-skip.svg`, `wild4.svg`, `back.svg`).
- **Server:** `apps/server/src/uno-manager.ts` holds the one live table and saves every move to `games.state_json` (`status`: `playing` = on screen incl. between rounds and after game over, `ended` = host closed it); it restores on boot. Socket handlers are in `app.ts` (`unoMove` for players, `admin:uno*` inside `registerAdmin`). Each seated player only gets `unoViewFor(...)` via `uno:state` / `sync`; the admin gets the full `UnoState` (god mode).
- **Phone UI** (`apps/web/src/uno/`): `UnoTable.tsx` (opponents with card-back stacks and counts, tap-the-pile to draw, discard with a colour ring for the active colour, highlighted playable cards, UNO! / Catch! / Pass buttons, Wild colour picker, Draw Four Challenge-or-draw prompt, log line, round/game-over scoreboard, vibrate on your turn), `Card.tsx`, `log.ts` (event to sentence), `send.ts` (emit + ack). `App.tsx` opens the table automatically when you are seated, and the UNO tile re-opens it.
- **Admin UI:** UNO tab (tick players, target score, Deal; then Skip turn, Deal next round, End table, god mode with every hand as card images) and a table panel on `/admin/tv`.
- **How to play (host):** `/admin` > UNO > tick the players > Deal. Players' phones open the table by themselves. If someone goes missing, **Skip turn**. When a round ends, **Deal next round**; after game over, **End table**.
- **Verify:** `npm test` (46 server tests incl. a real-socket UNO suite: privacy, every move type, refusals, round end, host controls, restart restore, audit; plus the card-asset test). `npm run cards` is deterministic (re-running changes no files). By hand: three phones/windows, seat them, play a round.
- **Not visually verified in a browser here** (no Chrome available in the build environment; Firefox could not be launched). Typecheck, build, the real server and scripted socket games were checked; please look at the table on a real phone and tell me what to adjust (card sizes, spacing, colours).
- **Deferred:** undo, auto-skip timer for away players (the engine's `skipTurn` is ready; the server needs a timer + the host-set timeout), force-draw, house-rule toggles (stacking, draw-until-play, 7-0, jump-in), several tables at once, sound effects, card animations, the host's spectator view of the table beyond the TV panel.
- **Known risk:** Tailwind v4 output may not run on very old Android browsers; test in Phase 7 hardening.

## Phase 7 (partial): 20-player load test + host guide (done)
- **Guide:** `docs/PARTY_GUIDE.md` is the host's one-stop document: full feature list with status, software to install on Windows, the network drill (router, DHCP reservation, firewall, power), the optional tunnel for phones outside the party Wi-Fi, the night-of runbook, troubleshooting, and the load-test results. Keep it current when features change. The Windows steps have not been run on Windows yet.
- **Load test:** `apps/server/src/loadtest/run.ts` (the scenario: 20 simultaneous sign-ins, half with PINs; sockets; 10 announcements; a UNO game with all 20 seated (or 10 seated + 10 spectating) played to the end by bots over several rounds; a SIGKILL restart mid-game; privacy and state-equality checks), `scripts/load-test.ts` (`npm run loadtest`: spawns an isolated real server with a throwaway DB, optional `--url` for an existing server), and `loadtest/load.test.ts` (the same scenario in-process inside `npm test`). Results are in the guide, section 7. Failures it detects: any non-benign refused move, a stalled game, a different table after restart, another player's cards on a phone, a spectator getting a table. Verified by deliberately breaking the server two ways (leak hands; do not restore the table) and confirming it failed.
- **Bot pitfall to remember:** each bot is single-flight (one action at a time, re-reading the table after each await). Without that, a catch or UNO press triggered a second concurrent action and produced "not your turn" refusals that looked like server bugs.
- **Security fix found while writing the networking section:** tunnelled traffic arrives from 127.0.0.1, so the localhost-only admin check would have trusted the internet. The server now treats any request with proxy headers as remote (see `docs/API.md`).
- **Still open in Phase 7:** test on an old Android phone, dark-mode polish, sound effects, a Windows dry run, running `npm run loadtest` on the Windows laptop, the Tailwind v4 browser-support check.

## Table size raised to 20 (done)
- One 108-card deck can't deal 20 hands (20 x 7 = 140), so the engine uses **two decks for 11-20 players** (`deckCountFor`, `buildDeck(decks)`); card ids run 0-215 and are unique, identical faces share one image. `MAX_PLAYERS = 20` in `packages/shared/src/uno.ts` drives the engine, the admin seat picker and the "tick everyone online" button. Tables saved before this change (1 deck, up to 10) still restore fine.
- Tests: deck/deal accounting for every table size 2-20, the 20/21 limits, a two-deck deck test, bot games across 2-20 players, and the load test with all 20 seated (`npm run loadtest` now seats everyone by default; `--seats 10` makes 10 spectate).
- Not changed: still **one UNO table at a time**. At 20 players a round is long and hands get large, so a lower target score suits.

## Next up
Candidates: Imposter on real phones (see below), the away-player auto-skip timer + undo, UNO house rules, or finishing Phase 7. Confirm with the host first.

## Wiring Imposter to real players (later)
Engine is `packages/shared/src/imposter.ts`. Server work: hold an `ImposterState` per game (persist to `games.state_json`; the `games.type` enum needs `'imposter'` via a new migration), add `imposter:start|vote|next` events, send each player `viewFor(state, id)` inside `sync` and on every change, resolve voting when `allVoted` or on host action. Replace the fake players in `ImposterPreview.tsx` with that view.
