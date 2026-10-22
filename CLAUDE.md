# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status
Phases 1 (skeleton), 2 (accounts + lobby), 3 (admin console + PIN), 5 (UNO engine) and 6 core (UNO playable on phones, with image cards) are built; Phase 4 (Dare or Dare) is switched off; Imposter is not wired to real players yet. Source of truth for intent: `docs/SPEC.md`. Build **one phase at a time** and stop for review after each.

**Docs to keep current** (update them in the same change, not afterwards):
- `docs/PARTY_GUIDE.md`: the host-facing guide (features and their status, Windows software, networking, runbook, load-test results).
- `docs/PROGRESS.md`: phase checklist, what each phase built and where, how to verify, what's next.
- `docs/API.md`: every HTTP endpoint and socket event, plus the auth model. Types live in `packages/shared/src/protocol.ts`.
- This file, when commands, structure or rules change.

## What this is
A LAN-only web app served from the host's laptop (Windows, "the Legion") at a fixed IP such as `http://192.168.0.10:3000`. Up to ~20 guests join from their phones by QR code to play **UNO** and **Imposter** (Among Us style). **Dare or Dare** is switched off for now (`enabled: false` in `packages/shared/src/games.ts`); its code and tables stay planned for later. The host controls everything from `/admin`. It must work with zero internet: no CDNs and no external APIs at runtime.

## Stack & layout (monorepo)
- `apps/server/`: Node 20, TypeScript, Fastify, Socket.IO, SQLite (Drizzle). In production it also serves the built web app.
- `apps/web/`: React, Vite, TypeScript, Tailwind. Player routes (`/join`, game views) and `/admin`.
- `packages/shared/`: shared types, the **UNO rules engine** (pure TS, no I/O) and the dare picker.
- `packages/shared` is consumed as TypeScript source (no build step). The server runs through `tsx`, and Vite compiles the shared code for the web app.

## Commands
- `npm install`: install all workspaces (Node 20+).
- `npm run party`: builds the web app and starts the server on `0.0.0.0:3000` (`PORT` env to change). This is the one command used on the night. Admin stays disabled until `ADMIN_PASSWORD` is set in `.env` (copy `.env.example`).
- `npm run dev`: server with `tsx watch` plus the Vite dev server (proxies `/api` and `/socket.io` to port 3000).
- `npm run typecheck`: `tsc` in every workspace.
- `npm run loadtest`: 20 simulated phones play UNO against an isolated real server that is killed and restarted mid-game (flags: `--players --seats --score --think --restart-after --url`). The same scenario runs in `npm test` (`apps/server/src/loadtest/`). Keep it passing when changing sockets, UNO, persistence or presence.
- `npm run cards`: regenerate the UNO card images in `apps/web/public/cards/` (deterministic; outputs are committed).
- `npm run db:generate -w @party/server`: after editing `apps/server/src/db/schema.ts`, generate a migration into `apps/server/drizzle/`. Migrations are applied automatically at server start.
- The SQLite file is `data/party.sqlite` (gitignored; override with `DB_PATH`). Copy `.env.example` to `.env` for config.
- `npm test`: Vitest across workspaces. One file: `npx vitest run packages/shared/src/imposter.test.ts`.

## Non-negotiable architecture rules
- **Server-authoritative.** Clients send only intents (`uno:play`, `uno:draw`, ...). The server validates, mutates state and pushes views. Clients never compute game outcomes.
- **Private state stays private.** Each player receives only their own UNO hand; opponents appear as card counts. Build per-player views on the server (`uno:state` is sent per player, never broadcast). The admin "god mode" is the only exception.
- **Persist after every move.** Live state is held in memory and snapshotted to `games.state_json` in SQLite, so a server restart resumes games mid-round.
- **Reconnect = full resync.** On socket (re)connect, re-send the player's complete current view. Session = random token in a cookie, valid 7 days. Phone number (normalised: strip spaces, `+44`/`+880`, leading `0`) is the account key. Logging in on a new device kicks the old socket.
- **Admin security.** Admin is off without `ADMIN_PASSWORD`, and `/admin` + `/api/admin/*` only answer the host machine (`isLocalAddress`) unless `ADMIN_ALLOW_REMOTE=1`. Admin sockets join the `admin` room; `admin:*` handlers are only registered on admin sockets, and such events from anyone else are logged as `admin_rejected`. Route every notable action through `record()` in `app.ts` (writes `audit_log` and refreshes the admin screen). Only admin sockets ever receive phone numbers. Requests carrying proxy/tunnel headers count as remote (a tunnel makes everything look like 127.0.0.1), so never loosen `looksProxied`.
- **PINs** are optional, 4 digits, scrypt-hashed, throttled; never log or return them.
- Phone-first UI: big tap targets, dark theme, must work on old Android browsers.

## Server structure
`apps/server/src/app.ts` exports `buildApp({ db, webDist })`, which wires HTTP routes, socket auth, presence and lobby broadcasts; `index.ts` just opens the DB and listens. Tests build the app on `openDb(':memory:')` and talk to it with `fetch` and `socket.io-client`. DB helpers live in `auth.ts`; admin helpers (sessions, throttle, local-address check) in `admin.ts`. Test helper: `helpers.test-util.ts` (`startServer()` returns a running app with `join`, `post`, `open` socket helpers). Admin UI is in `apps/web/src/admin/`; `App.tsx` routes `/admin*` there.

## Data model
Tables: `players`, `sessions`, `dares`, `dare_rounds`, `games` (`settings_json`, `state_json`), `audit_log`. Column lists are in the spec's "Data model & realtime events" section.

## Socket event naming
Events use `domain:action`: `uno:*`, `dare:*`, `lobby:update`, `announce`, `admin:*`. The payloads are listed in the spec.

## UNO engine notes
Engine: `packages/shared/src/uno.ts` (pure, immutable, 57 tests). Actions return a new state or throw `UnoError` (message is safe to show the player). Phones only get `unoViewFor(state, playerId)`; never send `UnoState`. The full list of rule decisions (Draw Four challenge semantics, UNO/Catch window, opening-card effects, winning on a Draw Two/Four) is in `docs/PROGRESS.md` under Phase 5. Keep it in sync if a rule changes.
- Default game target is 500 (host can lower it). House rules (stacking, draw-until-play, 7-0, jump-in) are NOT implemented yet.
- A disconnected player's turn is auto-skipped after a host-set timeout (default 45 s): call `skipTurn` from the server's timer; the engine has no timers.
- Add a test for every rule change; the bot-simulation test in `uno.test.ts` catches lost or duplicated cards.

## UNO on the server and phones
- `apps/server/src/uno-manager.ts` owns the single live table and saves every move to `games.state_json`; restored at boot. Player moves are `uno:*` events (ack with `{ ok, error }`), host controls are `admin:uno*`. Send phones only `unoViewFor(...)` (`uno:state`, `sync`); the full `UnoState` goes to admin sockets only. Details in `docs/API.md`.
- Cards are **image assets**, never text: `cardAsset(card)` gives the path; `scripts/generate-cards.ts` makes the SVGs (original art, not official UNO artwork). Keep new UI using `apps/web/src/uno/Card.tsx`.
- In server tests, wait for a rigged table with its unique top-card id (`riggedTop` in `uno.test.ts`), never a card value: a real dealt game can match a value by chance and make the test flaky.

## Imposter (Among Us style) notes
- Engine: `packages/shared/src/imposter.ts` (pure, tested). Random imposters (default 3, scaled down for small groups, always fewer than half). Players vote each round; most votes ejects, a tie or skip-majority ejects nobody; non-voters count as skip.
- Ejection reveals whether the player was an imposter. Crew win when all imposters are out; imposters win when they equal living crew. Full roles are revealed only when the game ends.
- Privacy: phones receive only `viewFor(state, playerId)`. Imposters see their teammates, crew see nothing extra. Never send raw `ImposterState` to a client.
- `apps/web/src/ImposterPreview.tsx` is a local demo of the vote/reveal UI with fake players. Real play needs Phase 2 (accounts) plus socket events (`imposter:*`), which are not wired yet.

## Dare picker notes (game currently disabled)
The picker uses fair random: recently picked players get a lower weight, and nobody is picked twice in a row. It respects Chaos opt-outs and avoids dares the player has already had. One-time dares are marked used. A `{player}` slot pulls in a second random player.

## Build phases
1 Skeleton → 2 Accounts + lobby → 3 Admin console → 4 Dare or Dare → 5 UNO engine (tests) → 6 UNO UI + admin controls → 7 Hardening (20 fake sockets, restart mid-game, old Android). The "done when" criteria for each phase are in the spec.
