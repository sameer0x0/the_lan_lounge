# Party Night — Local Game Server Spec

Oct 22, 2026 · @Sameer Roy

## Overview

A web app hosted on the Legion that guests open on their phones over the party Wi-Fi to play two games: **Dare or Dare** (host-written dares, random victims) and **UNO** (full rules, each player sees their own hand). The host runs everything from an admin console on the laptop.

**Goals**

- Guests join by scanning a QR code, then sign in with name + phone number.
- Coming back later (closed tab, phone died) puts them straight back into the same account and the same seat.
- The host can see and control every player and every game from one screen.
- Works with zero internet: everything is served from the laptop.
- Phone-first UI: big buttons, readable in a dark room, works on cheap Android browsers.

**Non-goals (for v1)**

- Hosting on the public internet, real security, or real SMS verification.
- Native apps. It's a website.
- More than \~20 concurrent players.

## Network & hosting

The spare router creates the party Wi-Fi; the Legion plugs into it and serves the app on a fixed local address that guests reach via a QR code.

1. **Router upstream:** plug the spare router's WAN port into your main router/modem so guests also get internet. (No internet needed for the games themselves.)
2. **Laptop connection:** connect the Legion to the spare router by **Ethernet** (more stable than Wi-Fi under 15+ phones polling sockets).
3. **Fixed IP:** in the router admin page, add a DHCP reservation for the Legion, e.g. `192.168.0.10`.
4. **Firewall:** allow inbound TCP on the app port (e.g. `3000`) on the **Private** network profile in Windows Defender Firewall, and set the party network to Private.
5. **Friendly address (optional):** if the router supports local DNS entries, map `party.lan` → `192.168.0.10`. Otherwise the QR code just encodes `http://192.168.0.10:3000`.
6. **QR poster:** the admin console shows a full-screen QR code + Wi-Fi details to put on a TV or print.
7. **Laptop settings:** plugged in, sleep disabled, Windows Update paused for the night, power mode on Balanced (plenty for this load).

The Legion is massive overkill for this, which is good: a single Node process handles 20 players easily.

## Tech stack & architecture

One Node.js server owns all game state and pushes updates over Socket.IO; phones and the admin console are thin React clients that only render what the server sends them.

&#91;embedded content: architecture · phones, router, Legion\]

Phones never talk to each other; every move goes through the server, which saves it and pushes the new view back out.

| Layer | Choice | Why |
| --- | --- | --- |
| Server | Node.js 20 + TypeScript + Fastify | Simple, fast, one process |
| Realtime | Socket.IO | Auto-reconnect, rooms per game, works on flaky phone Wi-Fi |
| Database | SQLite via Drizzle ORM (or Prisma) | Single file on disk, survives restarts, zero setup |
| Frontend | React + Vite + TypeScript + Tailwind | Fast to build, mobile-first styling |
| Shared code | `packages/shared` with types + UNO rules engine | Same types on client and server |
| Run | `npm run party` builds the client and serves it from the server | One command on the night |

**Key rules**

- **Server-authoritative:** clients send *intents* (`playCard`, `drawCard`), the server validates and broadcasts. Nobody can cheat by editing the page.
- **Private state stays private:** each player only ever receives their own UNO hand; others get card counts.
- **State is saved** to SQLite after every move, so a server restart resumes games mid-round.

**Repo layout**

```
party-night/
  apps/server/      # Fastify + Socket.IO + SQLite
  apps/web/         # React app (player + admin routes)
  packages/shared/  # types, UNO engine, dare picker
  CLAUDE.md         # this spec, condensed for Claude Code
```

## Player accounts

The phone number is the account key: the same number always returns the same player, with their name, points and seat intact.

**Sign-in flow**

1. Guest scans the QR code and lands on `/join`.
2. Enters **phone number** first. The server normalises it (strip spaces, `+44`/`+880` prefixes, leading `0`).
3. Known number → "Welcome back, Rafi" and straight in. New number → asks for a **display name** (unique for the night) and an optional avatar emoji.
4. Server sets a long-lived session cookie (random token, 7 days). Refreshing or reopening the tab skips login entirely.

**Reconnecting**

- Socket.IO reconnects automatically; on reconnect the server re-sends the player's full view (current game, their hand, whose turn).
- A dropped player shows as "away" to others. In UNO their turn is auto-skipped after a host-set timeout (default 45 s) rather than stalling the table.
- Logging in on a second phone moves the session there and kicks the old one.

**Privacy**

- Phone numbers live only in the local SQLite file on the Legion and are never shown to other players.
- The admin can export or wipe all player data after the party.
- Note: anyone who knows a friend's number could log in as them. Fine for a party; an optional 4-digit PIN per account closes that gap if wanted.

## Admin console

The admin console at `/admin` is a desktop layout for the Legion, protected by a password set in `.env` and only accepted from `localhost` by default, so guests can't reach it even if they guess the URL.

| Area | Controls |
| --- | --- |
| Lobby | Live list of players (online/away), rename, kick, ban for the night, reset PIN, merge duplicate accounts |
| Players | Move a player into or out of a game, mark as sitting out, adjust points, see last-seen time |
| Dare or Dare | Manage dare bank, start/pause round, force-pick a player, re-roll, mark done/skipped, award or deduct points |
| UNO | Create table, pick seats, deal, skip a turn, force-draw, undo last move, view any hand (god mode toggle), end round, toggle house rules |
| Broadcast | Push an announcement banner to every phone ("Pizza's here") |
| Display | Full-screen "TV mode": QR code, current dare in huge text, UNO discard pile + whose turn |
| System | Export/wipe data, restart game state, show server IP and connected count |

Every admin action is written to an audit log so disputes ("you rigged that pick!") can be settled.

## Game 1: Dare or Dare

The host loads a bank of dares; each round the server picks a player and a dare at random, everyone sees it, and the host marks it done or chickened out.

**Dare bank**

- Each dare has: text, intensity (Mild / Spicy / Chaos), points value, optional timer (e.g. 60 s), and an optional `{player}` slot that pulls in a second random player ("Do your best impression of {player}").
- Add dares one by one in the admin console or bulk-import from a `.txt`/`.csv` file.
- Dares can be marked one-time-only or repeatable.

**Round flow**

1. Host taps **Spin**. All phones show a spinning name wheel for \~3 s (pure suspense).
2. Server picks the player using **fair random**: players picked recently are weighted down so nobody gets hammered, and nobody is picked twice in a row.
3. Server picks a dare at the current intensity level that the player hasn't had yet.
4. Every phone shows: player name, dare text, countdown timer. The chosen player's phone buzzes (vibration API) and goes full-screen red.
5. Host marks **Done** (+points), **Chickened out** (penalty: −points or a bonus forfeit dare), or **Re-roll**.
6. Leaderboard updates on all phones.

**Options**

- Intensity can escalate automatically every N rounds.
- Players can opt out of Chaos-level dares in their settings; the picker respects it.
- "Veto token": each player gets one skip per night (host-configurable).

## Game 2: UNO

Standard UNO for 2–20 players per table (one deck up to 10 players, two decks for 11–20), with house rules available as admin toggles that default to off.

**Deck (108 cards)**

| Card | Per colour | Total | Effect |
| --- | --- | --- | --- |
| 0 | 1 | 4 | — |
| 1–9 | 2 each | 72 | — |
| Skip | 2 | 8 | Next player loses their turn |
| Reverse | 2 | 8 | Direction flips; acts as Skip with 2 players |
| Draw Two | 2 | 8 | Next player draws 2 and loses their turn |
| Wild | — | 4 | Player picks the colour |
| Wild Draw Four | — | 4 | Picks colour; next player draws 4 and loses their turn |

**Core rules (enforced by the server)**

1. Shuffle, deal 7 each, flip the top card to start the discard pile. A Wild Draw Four start is reshuffled back in; other action cards apply to the first player.
2. On your turn, play a card matching the top card's **colour, number or symbol**, or any Wild.
3. Can't or won't play → draw one card. If it's playable you may play it immediately; otherwise your turn ends.
4. **Wild Draw Four** is only legal when you hold no card of the current colour. The next player may **challenge**: if the player was bluffing they draw 4 instead; if not, the challenger draws 6.
5. **UNO call:** when you drop to one card you must hit the UNO button. If another player hits **Catch!** before the next player acts, you draw 2.
6. Empty draw pile → reshuffle the discard pile (except the top card) into a new draw pile.
7. First to empty their hand wins the round and scores the points left in opponents' hands: numbers = face value, Skip/Reverse/Draw Two = 20, Wilds = 50. First to 500 wins the game (host can set a lower target).

**What each phone shows**

- Your hand along the bottom, playable cards highlighted, others dimmed.
- Current top card and active colour, big and centred; draw pile next to it.
- Opponents around the top: name, card count, "UNO!" badge, turn arrow and direction.
- UNO and Catch! buttons, colour picker modal for Wilds, challenge prompt for Draw Four.
- Short log line: "Nadia played Draw Two on Rafi".

**House-rule toggles (off by default)**

- Stacking Draw Two / Draw Four
- Draw until you can play
- 7-0 (7 swaps hands, 0 rotates all hands)
- Jump-in (play an identical card out of turn)
- Turn timer length

## Data model & realtime events

Six SQLite tables cover everything; live game state is also kept in memory and snapshotted to `games.state_json` after each move.

| Table | Key columns |
| --- | --- |
| `players` | id, phone (unique, normalised), name, avatar, pin\_hash?, points, banned, created\_at, last\_seen |
| `sessions` | token, player\_id, created\_at, expires\_at |
| `dares` | id, text, intensity, points, timer\_s, uses\_second\_player, one\_time, used |
| `dare_rounds` | id, dare\_id, player\_id, second\_player\_id, outcome, created\_at |
| `games` | id, type (uno), status, settings\_json, state\_json, created\_at |
| `audit_log` | id, actor (admin/player id), action, payload\_json, created\_at |

**Socket events**

| Direction | Event | Payload |
| --- | --- | --- |
| client → server | `uno:play` | cardId, chosenColour? |
| client → server | `uno:draw` / `uno:pass` | — |
| client → server | `uno:callUno` / `uno:catch` | targetPlayerId? |
| client → server | `uno:challenge` | — |
| server → player | `uno:state` | your hand, top card, colour, turn, opponents' counts |
| server → all | `dare:spin` / `dare:result` | playerId, dare, timer |
| admin → server | `admin:*` | e.g. `admin:kick`, `admin:skipTurn`, `admin:broadcast` |
| server → all | `lobby:update` / `announce` | player list / banner text |

Admin sockets join an `admin` room and are verified on connect; any `admin:*` event from a non-admin socket is rejected and logged.

## Build plan (Claude Code)

Build in seven phases, each ending with something you can test on two phones; UNO's rules engine comes before its UI so it can be unit-tested hard.

1. **Skeleton** — monorepo, Fastify serves the Vite build, Socket.IO handshake, SQLite + migrations, `npm run party`. *Done when:* a phone on the router opens the page by IP.
2. **Accounts + lobby** — phone/name join, session cookie, reconnect, live lobby list. *Done when:* closing and reopening the tab lands you back in, same name.
3. **Admin console** — password login, localhost guard, lobby controls (kick, rename, ban), broadcast, QR/TV mode, audit log.
4. **Dare or Dare** — dare bank CRUD + import, fair picker, spin animation, timer, outcomes, leaderboard.
5. **UNO engine** — pure TypeScript in `packages/shared`: deck, shuffle, deal, legality, actions, Draw Four challenge, UNO call/catch, reshuffle, scoring. Vitest suite covering every rule above.
6. **UNO UI + admin controls** — table view, hand, colour picker, challenge/catch buttons, turn timer, god mode, undo.
7. **Party hardening** — load test with 20 fake sockets, kill-and-restart the server mid-game, test on an old Android phone, dark-mode polish, sounds and vibration.

**Kick-off prompt for Claude Code**

> Read `docs/SPEC.md` (this doc, exported as Markdown). Create `CLAUDE.md` summarising the stack, repo layout and rules (server-authoritative, hands private). Then implement Phase 1 only and stop for review.

Export this doc as Markdown into the repo as `docs/SPEC.md` so Claude Code has the full context, and tick phases off here as you go.

## Open questions

- [ ] Party date, and how many guests to expect?
- [ ] One UNO table, or several running at once if 15+ people want to play? **v1 runs one table** (up to 20 seated); the code keys the table by its `games` row so several can be added later.
- [x] Optional 4-digit PIN on accounts, or phone number alone? **Decided: optional PIN, built in Phase 3.**
- [ ] Can someone play Dare or Dare and UNO at the same time, or is it one game at a time for everyone?
- [ ] Should the TV/projector mode be in v1?
- [ ] Spare router model (to confirm DHCP reservation and local DNS support).

## Game 3: Imposter (added)

An Among Us style game for the whole party. The server randomly picks 3 imposters out of ~20 players (fewer for small groups). Each phone shows the player's role privately; imposters also see their fellow imposters.

- Each round everyone alive votes for who to eject, or skips. Most votes is ejected; ties or a skip majority eject nobody.
- After an ejection everyone sees whether that player was an imposter.
- Crew win when all imposters are ejected. Imposters win when they equal the living crew. At the end all roles are revealed.

**Dare or Dare is switched off for now** (kept in the spec for later).

## Card art (added)
UNO cards are image files, not text. They are original SVG artwork generated by `npm run cards` (not the official UNO design) and live in `apps/web/public/cards/`; replace the files, keeping the names, to use custom artwork.
