# API & socket contract

Source of truth for types: `packages/shared/src/protocol.ts`. **Update this file whenever you add or change an endpoint or socket event.**

## Auth model
- Identity = normalised phone number (`normalizePhone` in `packages/shared/src/phone.ts`: strips spaces/punctuation, `+44`/`+880`/`00` prefixes and one leading `0`, so `+44 7700 900123` and `07700 900123` are the same account).
- Session = random token in the `pn_session` cookie (httpOnly, SameSite=Lax, 7 days), stored in the `sessions` table. **One session per player**: a new login deletes the old one and kicks the old sockets.
- Phone numbers never leave the server except to **admin sockets** (`AdminPlayer.phone`). Everything sent to players uses `PlayerPublic` / `Me`.
- **PIN (optional, 4 digits):** set at sign-up or later via `POST /api/pin`. Stored as `salt:scrypt-hash` in `players.pin_hash`. An account with a PIN answers `needPin` until the right PIN is sent. 5 wrong tries lock that account's PIN checks for 60 s (in memory, 429). The host can clear a forgotten PIN (`admin:resetPin`).
- **Admin auth** is separate: `pn_admin` cookie (httpOnly, SameSite=Strict, 12 h, held in server memory so a restart signs the host out). Admin is **off until `ADMIN_PASSWORD` is set**, and only works from the host machine (loopback or the server's own LAN IP) unless `ADMIN_ALLOW_REMOTE=1`. A request that carries proxy/tunnel headers (`X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-Ip`, `Forwarded`, `CF-Connecting-IP`, `True-Client-IP`) counts as **remote** even from 127.0.0.1, because Cloudflare Tunnel / ngrok / Tailscale Funnel traffic arrives from the laptop itself (`looksProxied` in `admin.ts`, covered by tests; applies to HTTP and the socket handshake). From any other address `/admin*` is a 404 and `/api/admin/*` a 403. 5 wrong passwords lock that IP for 60 s.
- Caveat: with the Vite dev server (`npm run dev`) requests are proxied from localhost, so the host check can't tell guests from the host. Only rely on it with `npm run party`.

## HTTP
| Method & path | Body | Result |
| --- | --- | --- |
| `GET /api/health` | | `{ ok, time }` |
| `POST /api/join` | `{ phone, name?, avatar?, pin? }` | Known number: `{ status: 'welcomeBack', me }` + cookie. Known number with a PIN and no `pin` sent: `{ status: 'needPin' }` (no cookie). Unknown number without `name`: `{ status: 'needName' }` (no cookie). Unknown with `name` (and optional `pin`): `{ status: 'created', me }` + cookie. Errors: 400 bad number / name too long / bad PIN format, 401 wrong PIN, 403 banned, 409 name taken (case-insensitive), 429 PIN locked |
| `GET /api/me` | | `{ me }` or 401 |
| `POST /api/pin` | `{ pin: '1234' \| null }` | Set/change/remove your own PIN. Returns `{ me }`. 401 if signed out, 400 if not 4 digits |
| `POST /api/logout` | | `{ ok: true }`, clears cookie |
| `POST /api/admin/login` | `{ password }` | `{ ok }` + `pn_admin` cookie. 401 wrong, 429 locked, 403 not the host machine, 503 `ADMIN_PASSWORD` not set |
| `GET /api/admin/me` | | `{ ok }` or 401 (used by the admin page to decide login vs console) |
| `POST /api/admin/logout` | | `{ ok }` |

Any other non-`/api` GET falls back to the React app (`index.html`), so `/join` and `/admin` load on refresh.

## Socket.IO
The handshake is authenticated by cookie: a valid player session (`pn_session`) makes it a **player socket**, a valid admin session from the host machine makes it an **admin socket**, both cookies make it both (the host playing from the laptop). Neither gives a `connect_error` with message `unauthorized`. Admin-only sockets are not players: no presence, no `sync`.

| Direction | Event | Payload | Notes |
| --- | --- | --- | --- |
| server → client | `sync` | `{ serverTime, me, players, uno }` | Full state (`uno` = your `UnoPayload` or null). Sent on **every** (re)connect. Add new per-player state (current game view, hand, turn) here so reconnects restore it |
| server → all | `lobby:update` | `PlayerPublic[]` | After any join, connect, disconnect. `online:false` shows as "away" |
| server → client | `kicked` | `{ reason: 'otherDevice' \| 'admin' \| 'banned' }` | Followed by a disconnect. Client signs out and shows a message |
| server → client | `uno:state` | `UnoPayload \| null` | `{ view, seats }`: your own `UnoView` (hand, playable ids, top card, counts, challenge, catchable, log) plus `seats` (id, name, avatar, online). Sent to every player socket after any table change or presence change; `null` for players who aren't seated and when the table ends |
| server → all | `announce` | `{ id, text }` | Host banner; phones show it until tapped and vibrate |
| client → server | `ping` | ack `(serverTime)` | Latency check |

### UNO moves (seated players)
Each takes an ack `(result: { ok: true } | { ok: false, error })`. The error is the engine's player-safe message ("It is not your turn", "That card doesn't match the top card", "You are not in this game", "No UNO game is running"...). A refused move changes nothing.

| Event | Payload | Meaning |
| --- | --- | --- |
| `uno:play` | `{ cardId, color? }` | Play a card from your hand. Wilds require `color` (`red\|yellow\|green\|blue`) |
| `uno:draw` | | Draw from the pile on your turn; or, when a Wild Draw Four is aimed at you, accept it (take 4, lose your turn) |
| `uno:pass` | | After drawing a playable card, decline to play it |
| `uno:callUno` | | Press UNO with 1-2 cards |
| `uno:catch` | | Catch whoever `view.catchable` names (draws 2) |
| `uno:challenge` | | Call the bluff on a Wild Draw Four aimed at you |

Player ids in the engine are `String(players.id)`. Only one table exists at a time (v1); every move is saved to `games.state_json`, and the table is restored on server start.

### Admin events (admin sockets only)
On connect, and after every change, admin sockets receive `admin:state` = `{ players: AdminPlayer[], audit: AuditEntry[] (latest 150), system: { joinUrls, wifi, connected, localOnly }, uno: { state, seats } | null }`. `uno.state` is the **full** `UnoState` with every hand (god mode); it only ever goes to admin sockets. Commands carry an ack `(result: { ok: true } | { ok: false, error })`. Each successful command is written to `audit_log` with actor `admin`.

| Event | Payload | Effect |
| --- | --- | --- |
| `admin:kick` | `{ playerId }` | Deletes their session, disconnects them with `kicked: admin`. They can sign in again |
| `admin:ban` | `{ playerId, banned }` | Ban also kicks (`kicked: banned`); banned players can't sign in and vanish from the lobby. `banned: false` lifts it |
| `admin:rename` | `{ playerId, name }` | Same rules as sign-up (1-20 chars, unique ignoring case) |
| `admin:resetPin` | `{ playerId }` | Removes their PIN and clears any lockout |
| `admin:broadcast` | `{ text }` | Emits `announce` to everyone (max 200 chars) |
| `admin:unoCreate` | `{ playerIds, targetScore? }` | Seats 2-10 non-banned players (in that order) and deals. Replaces any open table |
| `admin:unoSkip` | (ack only) | Ends the current player's turn (accepts a Draw Four if one is aimed at them) |
| `admin:unoNextRound` | (ack only) | Deals the next round (only when the round is over and nobody reached the target) |
| `admin:unoEnd` | (ack only) | Closes the table for everyone (`games.status = 'ended'`) |

Any `admin:*` event from a socket that isn't an admin socket is ignored and logged as `admin_rejected` (actor = the player).

### Audit log actions
`join`, `login`, `pin_set`, `pin_removed`, `pin_failed`, `admin_login`, `admin_login_failed`, `admin_rejected`, `kick`, `ban`, `rename`, `reset_pin`, `broadcast`, `uno_create`, `uno_skip`, `uno_next_round`, `uno_end`, `uno_round_over`, `uno_game_over` (the last two have actor `system`). Individual card plays are not audited; they live in `UnoState.log`.

Presence is tracked per player as a set of socket ids, so a flaky reconnect (new socket before the old one times out) never shows the player as away.

## Planned (not built yet)
`dare:*`, `imposter:*`, and the rest of the `admin:*` family (points, undo, force-draw, house-rule toggles, export/wipe, merge duplicates). See `docs/SPEC.md` for the intended payloads.
