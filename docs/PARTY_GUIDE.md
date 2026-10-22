# Party Night: features, hosting on Windows, networking, and the 20-player test

This is the one document to read before the party. Developer details live in `docs/API.md` (wire contract), `docs/PROGRESS.md` (what was built, phase by phase) and `docs/SPEC.md` (the original spec).

> **Honest status:** developed and tested on macOS with Node 20. The Windows steps below are the standard ones but **have not been run on a Windows machine yet**, so do a full dry run with two phones the day before. The tunnel option in section 5 is also untested here (only its security rule is). Everything marked "tested" was run, with the results in section 7.

---

## 1. What it is

A website that runs **on your Windows laptop**. Guests join your party Wi-Fi, scan a QR code, sign in with a phone number, and play games on their own phones. You run everything from `/admin` on the laptop. No internet is needed during the party; everything is served from the laptop.

```
  phones (up to ~20)           spare router                    Windows laptop
  ┌────────┐  Wi-Fi          ┌────────────┐   Ethernet cable   ┌──────────────────┐
  │ browser│ ─────────────►  │ DHCP, Wi-Fi│ ─────────────────► │ Node server :3000│
  └────────┘                 └─────┬──────┘                    │ SQLite file      │
                                   │ (optional WAN cable)      │ /admin (you only)│
                                   ▼                           └──────────────────┘
                              home router / internet
```

---

## 2. Features

### Guests (on their phones)
| Feature | Details | Status |
| --- | --- | --- |
| Join by QR | Scan, enter phone number; new numbers pick a display name (unique for the night) and an emoji avatar | Done |
| Same account, same seat | Closing the tab or a dead phone: reopening returns you to the same account (7-day cookie). Phone formats `+44 7700 900123`, `07700 900123` and `7700900123` are the same person (`+880` too) | Done, tested |
| Optional 4-digit PIN | Add, change or remove it from the home screen. Stops a friend signing in as you. Stored hashed; 5 wrong tries locks that account's PIN for 1 minute | Done, tested |
| Live lobby | Who is here, online or away, updates instantly | Done, tested |
| One device per account | Signing in on a second phone signs out the first, with a message | Done, tested |
| Host announcements | A banner on every phone with a buzz ("Pizza's here") | Done, tested |
| Privacy | Phone numbers are visible only to you on the admin screen, never to other guests | Done, tested |
| Reconnects | Flaky Wi-Fi reconnects by itself and the phone is handed its whole current state again | Done, tested |

### Games
| Game | What you get | Status |
| --- | --- | --- |
| **UNO** (2-20 per table) | Full rules: 108 cards (tables of 11-20 shuffle in a second deck so everyone can be dealt 7), draw / play / pass, Skip, Reverse, Draw Two, Wild, Wild Draw Four with **challenge** (bluff: they draw 4; honest: you draw 6) or accept, **UNO!** and **Catch!** (2-card penalty), pile reshuffle, round scoring (numbers face value, actions 20, wilds 50), first to 500 (host can lower it). **Cards are images**; your hand along the bottom with playable cards lifted and glowing, tap the pile to draw, colour ring on the discard pile, Wild colour picker, opponents shown with card backs and counts, "who did what" log line, buzz on your turn, scoreboard between rounds. Hands are private: a phone only ever receives its own cards. Saved after every move, so a server restart resumes mid-hand | Done, tested |
| **Imposter** (Among Us style) | 3 random imposters among ~20, vote people out, reveal whether each ejected player was an imposter, win conditions, roles private. **Practice mode only** on phones (uses the people online, others' votes simulated). Not yet a live shared game | Engine done and tested; live play **not built** |
| **Dare or Dare** | Planned in the spec | **Switched off** (shown greyed out) |
| UNO house rules | Stacking, draw-until-play, 7-0, jump-in | Not built |

### Host (`/admin` on the laptop)
| Feature | Details |
| --- | --- |
| Locked down | Needs `ADMIN_PASSWORD` (admin is off until you set it). Only answers the laptop itself; guests get a "not found" page. Wrong passwords are throttled. Requests arriving through a tunnel or proxy count as remote and are refused, even though they arrive from the laptop (tested) |
| Players tab | Live list with phone numbers, online/away, PIN set, points, last seen. **Rename, Kick** (they can rejoin), **Ban/Unban** for the night, **Reset PIN** |
| UNO tab | Tick who sits down (2-20), choose the target score, **Deal**. Then **Skip turn** (for someone who wandered off), **Deal next round**, **End table**, and a **God mode** switch that shows every hand as card images |
| Broadcast tab | Send a banner to every phone, with quick presets |
| Audit log tab | Every admin action and notable event (joins, logins, wrong PINs, kicks, rejected admin attempts, table events), so "you rigged that!" can be settled |
| System tab | Guest address, Wi-Fi details, how many are connected |
| **TV mode** (`/admin/tv`) | Full-screen QR code, Wi-Fi name and password, who is here, and the UNO discard pile with whose turn it is. The QR is generated in the browser, so it works offline |

### Not built (so you aren't surprised)
Dare or Dare, live Imposter, UNO undo, an automatic timer that skips absent players (use **Skip turn**), UNO house rules, more than one UNO table at a time, merging duplicate accounts, export/wipe buttons (see section 6 for wiping), points adjustment, sound effects, card animations. Very old Android browsers are untested.

---

## 3. Software you need on the Windows laptop

| Need | Why | How |
| --- | --- | --- |
| **Node.js LTS** (20 or newer) | Runs the server. Tested here on Node 20.20; Node 20's support is ending, so Node 22 LTS is the safer pick but is untested by me | `winget install OpenJS.NodeJS.LTS` (or the installer from nodejs.org). Check with `node -v` and `npm -v` |
| **The project folder** | The app itself | Copy the `Party Night` folder over (USB or cloud drive). You can leave out `node_modules` and `data` |
| **Internet, once** | `npm install` downloads packages. After that the party runs fully offline | Do this at home, before the party |
| **A browser** (Edge or Chrome) | To use `/admin` and `/admin/tv` on the laptop | Already installed |
| **Windows PowerShell** | Firewall and power commands, running the server | Already installed (run as **Administrator** for the firewall step) |
| Visual Studio Build Tools + Python | **Only if** `npm install` fails while building `better-sqlite3` (normally it downloads a ready-made binary and needs neither) | `winget install Microsoft.VisualStudio.2022.BuildTools` (with the "Desktop development with C++" workload) |
| `cloudflared` | **Only** for the optional "outside the party Wi-Fi" mode in section 5 | `winget install Cloudflare.cloudflared` |
| Git, Docker, a database server, IIS | **Not needed** | |

**Hardware:** a router that can make its own Wi-Fi (your spare one), an Ethernet cable for the laptop, the laptop's charger. A TV or projector is optional for the QR code and TV mode.

### First-time setup (at home, with internet)
```powershell
cd "C:\path\to\Party Night"
npm install
copy .env.example .env
notepad .env          # set ADMIN_PASSWORD (and WIFI_SSID / WIFI_PASSWORD so the TV shows them)
npm run party         # builds the website, starts the server
```
`npm run party` prints the addresses:
```
Party Night is up. DB: ...\data\party.sqlite
  This machine: http://localhost:3000
  Guests:       http://192.168.0.10:3000
  Admin:        http://localhost:3000/admin
```
Windows will pop up a firewall prompt the first time: allow it on **Private** networks (or use the rule in section 4).

### `.env` settings
| Variable | Meaning | Default |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Admin password. **Admin is disabled without it.** Change `change-me`! | none |
| `PORT` | Port to serve on. `80` removes the `:3000` from the address | `3000` |
| `WIFI_SSID`, `WIFI_PASSWORD` | Shown on the TV page and System tab | empty |
| `PUBLIC_URL` | Address put in the QR code, e.g. `http://192.168.0.10:3000` or `http://party.lan:3000` (comma-separate several; the first is used). Set this if the laptop has several network cards and the QR shows the wrong IP | auto-detected |
| `ADMIN_ALLOW_REMOTE` | `1` lets other devices open `/admin`. Leave it at `0` | `0` |
| `DB_PATH` | Where the database file lives | `data/party.sqlite` |

---

## 4. The network drill (party Wi-Fi, the main way)

Do this once at home and write down the laptop's address.

1. **Router upstream (optional but recommended).** Plug the spare router's **WAN/Internet** port into your main router so guests also get internet. The games don't need it, but see the "No Internet" warning in step 9.
2. **Laptop on Ethernet.** Plug the laptop into a **LAN** port of the spare router. Ethernet is far steadier than Wi-Fi when 20 phones are connected.
3. **Wi-Fi.** In the spare router's admin page set a Wi-Fi name and password (put the same in `.env` as `WIFI_SSID` / `WIFI_PASSWORD`). Use 5 GHz if offered, place the router in the middle of the room, **don't use its "Guest network" mode** (it blocks guests from reaching the laptop), and turn off "AP/client isolation" if phones can't reach the laptop.
4. **Fixed address.** Find the laptop's MAC address with `ipconfig /all` ("Physical Address" of the Ethernet adapter). In the router, add a **DHCP reservation** for it, e.g. `192.168.0.10`, so the address never changes. Reboot the laptop's network (unplug/replug) and confirm with `ipconfig`.
5. **Windows network profile = Private.** Settings, Network & internet, Ethernet, Network profile type: **Private network**.
6. **Firewall rule** (PowerShell as Administrator):
   ```powershell
   New-NetFirewallRule -DisplayName "Party Night" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private
   ```
   (If you changed `PORT`, use that number.)
7. **Keep the laptop awake** (PowerShell as Administrator), and plug it in:
   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   powercfg /change monitor-timeout-ac 30
   ```
   Also: set the power mode to Balanced and **Pause updates** (Settings, Windows Update) for the night, so it doesn't restart mid-game.
8. **Friendly address (optional).** If the router supports local DNS entries, map `party.lan` to `192.168.0.10`, then set `PUBLIC_URL=http://party.lan:3000`. Otherwise the QR simply encodes `http://192.168.0.10:3000`. With `PORT=80` guests don't need the `:3000`.
9. **Test with a phone** before guests arrive: join the party Wi-Fi, open `http://192.168.0.10:3000/api/health` (you should see `{"ok":true,...}`), then open the home page and sign in.
   - **"No Internet" warning:** if the party Wi-Fi has no internet upstream, some phones show that warning and quietly switch to mobile data, which breaks the page. Fix: do step 1, or tell guests to switch off mobile data.
10. **QR poster.** Open `http://localhost:3000/admin`, sign in, press **TV mode**, put it on the TV (full-screen with F11). Guests scan it.

**Night-of checklist:** laptop plugged in and on Ethernet, `npm run party` running, firewall rule in place, phone test passed, `/admin` signed in, TV mode up, Wi-Fi details on screen.

---

## 5. Using it from outside the party Wi-Fi ("a separate website")

By default the game only exists on your party network. If you want phones that are **not on your router** (friends at home, a second venue) to join, the standard safe way is a **tunnel**: the laptop makes an outbound connection to a service, and the service gives you a public `https://` address that forwards to your laptop. No router settings change.

**Cloudflare quick tunnel (free, no account), not tested here:**
```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```
It prints an address like `https://something-random.trycloudflare.com`. Then:
1. Put that address in `.env` as `PUBLIC_URL=https://something-random.trycloudflare.com`, restart `npm run party`, and the TV page / QR code now encodes the public address.
2. Anyone who opens it lands on the same join page and plays in the same game as the Wi-Fi guests (they share one lobby and one UNO table).
3. Close the tunnel window (Ctrl+C) when the party ends. The address dies with it.

Alternatives with the same shape: `ngrok http 3000`, or Tailscale (private network for invited people only, the safest option if the remote guests are friends).

**What stays protected, and what doesn't**
- `/admin` stays locked to the laptop even with a tunnel. Tunnels forward traffic from the laptop itself, so the server also refuses any request that carries proxy headers (`X-Forwarded-For`, `CF-Connecting-IP`, ...). This is covered by a test.
- Anyone who has the link can create an account and join. There is no guest list; you can ban people from the Players tab. Don't post the link publicly.
- Phone numbers go over the internet to your laptop (over HTTPS through the tunnel). Encourage **PINs**, and use a strong `ADMIN_PASSWORD`.
- There is no rate limiting beyond the PIN and admin-password throttles. This is a party tool, not a hardened public service, which matches the spec's non-goals.
- Every move now travels through a relay, so expect tens to a couple of hundred milliseconds extra per action. Fine for UNO.
- The laptop must stay on and connected; the data is still in `data/party.sqlite` on it.

**Not supported:** putting the web pages on a different website from the game server (for example the site on Netlify and the game on your laptop). The app uses same-site cookies and one address by design. To get a nicer domain name, use a named Cloudflare tunnel on a domain you own, which still points at the laptop.

**Exposing it by router port-forwarding** (opening port 3000 to the internet) works but I advise against it: no HTTPS, your home IP is exposed, and there's no protection from scanners.

---

## 6. Running the night

**Before guests:** the checklist at the end of section 4. Confirm `npm run party` shows `Admin: http://localhost:3000/admin` (not "DISABLED").

**During:**
- Guests scan, sign in, appear in the lobby. Press **TV mode** on the TV.
- **UNO:** `/admin` > UNO > tick the players (2-20) > set "first to" points (a shorter game, such as 100-150, suits a party) > **Deal**. Their phones open the table by themselves. If someone goes missing, **Skip turn**. After a round, **Deal next round**. After game over, **End table**.
- Announcements: Broadcast tab.
- Trouble with a guest: Players tab > Kick (signs them out) or Ban.
- Someone forgot their PIN: Players tab > **Reset PIN**.
- If the server dies or the laptop restarts: run `npm run party` again. Everyone's accounts and the UNO table are restored; phones reconnect on their own. You'll need to sign in to `/admin` again.

**After:** stop the server (Ctrl+C). To erase everyone's phone numbers, delete the files in the `data` folder (`party.sqlite`, `party.sqlite-wal`, `party.sqlite-shm`) while the server is stopped. (There's no wipe button yet.)

### Troubleshooting
| Symptom | Likely cause and fix |
| --- | --- |
| Phone can't open the address | Not on the party Wi-Fi (mobile data on?), laptop not on the router, wrong IP (`ipconfig`), firewall rule missing or network is "Public", router "Guest network"/AP isolation on |
| Page loads but says "Connecting..." / "Reconnecting..." | Wi-Fi dropped; it recovers by itself. If it persists, check the server window is still running |
| QR shows the wrong address | Laptop has several network cards: set `PUBLIC_URL` in `.env` and restart |
| `/admin` says not found / disabled | You're not on the laptop itself, or `ADMIN_PASSWORD` isn't set in `.env` |
| `/admin` login keeps failing | Throttled after 5 wrong tries; wait a minute |
| "That name is taken" | Display names are unique ignoring case; pick another or ask the host to rename |
| Guest locked out of their account | Forgotten PIN: Players tab > Reset PIN. Wrong-PIN lock clears after a minute |
| UNO: "It is not your turn" | Stale tap; ignore. If the game is stuck on someone, **Skip turn** |
| `npm install` fails on `better-sqlite3` | Install the Build Tools (section 3) and retry |
| Port 3000 already in use | Another program has it; close it or set `PORT=3100` in `.env` (and update the firewall rule) |

---

## 7. The 20-player test

**What it does** (`npm run loadtest`): starts a real, separate server process with a throwaway database (your party data is never touched), then drives it with 20 simulated phones over real HTTP and WebSockets:
1. 20 players sign up **at the same moment** (half with a PIN, which is the expensive case).
2. All 20 sockets connect; every phone must see all 20 online.
3. The host connects and broadcasts 10 announcements; every phone must receive each.
4. All 20 are seated at one UNO table (two decks), or, in the second variant, 10 sit and 10 spectate. Bots play a complete game by the rules (drawing, playing, UNO calls, catching, Draw Four challenges) until someone wins, over several rounds when the target is high.
5. **Mid-game, the server process is killed (SIGKILL) and restarted.** All 20 phones must reconnect, and the table must come back exactly: same turn, same top card, same hands.
6. Privacy is checked against the server's own state: no phone may receive another player's cards, and spectators must receive no table.

It fails on any refused move that isn't a normal bot race, a stalled game, a mismatch after the restart, or a privacy leak. The same scenario also runs inside `npm test` against an in-process server. I broke the server on purpose (leaking hands; forgetting the table after a restart) and confirmed the test caught both.

**Results** (macOS, Node 20, everything on one machine via loopback), all 20 players seated at one UNO table:

| Run | Moves | Rounds | Outcome |
| --- | --- | --- | --- |
| `npm run loadtest` | 261 | 1 | Pass, all 20 phones back after the restart in 355 ms |
| `--think 40 --score 1500 --restart-after 250` | **1,105** | **7** | Pass, recovered in 509 ms |

The "10 play, 10 spectate" variant also passes (inside `npm test`, repeated runs), and earlier standalone runs of it did too (up to 1,332 moves over 7 rounds).

Latency from the long run (milliseconds):

| Measure | p50 | p95 | max |
| --- | --- | --- | --- |
| Sign-in, 20 at once (half with PIN) | 154 | 248 | 248 |
| Socket connects and gets full state | 16 | 25 | 25 |
| Announcement reaches all 20 phones | 1 | 1 | 1 |
| UNO move acknowledged | 15 | 18 | 23 |
| Move to the next player's phone updating | 9 | 15 | 34 |

Server memory stayed at about **125-140 MB**. A UNO update is about **3.7 KB** per seated phone at a 20-player table, which is trivial for Wi-Fi.

**What this does and doesn't prove**
- It proves the **server and game logic** handle 20 connected players at one UNO table, simultaneous sign-ins and a hard restart. Tens of milliseconds of server time leaves enormous headroom.
- It does **not** test real Wi-Fi. With 20 phones the limit is your router, so use 5 GHz, put it in the middle of the room, and keep the laptop on Ethernet.
- UNO seats up to 20 at one table (one table at a time). A 20-player round is long (about 100-250 moves) and the hands are big, so for a better game consider a lower target score or two tables later. Imposter isn't part of the test because it isn't live yet.
- Run it on the Windows laptop too (`npm run loadtest`) for a Windows result. It needs nothing else installed.

Options: `npm run loadtest -- --players 20 --seats 20 --score 300 --think 400 --restart-after none` (use `--seats 10` to let the other 10 spectate). Pointing it at your real server with `--url` works but adds fake "Load.." players to that database, so avoid that during a real party.

---

## 8. Commands cheat sheet

| Command | What it does |
| --- | --- |
| `npm install` | Install everything (needs internet, once) |
| `npm run party` | Build the website and start the server: the one command for the night |
| `npm run dev` | Developer mode with live reload |
| `npm test` | All 129 automated tests (includes the 20-player test) |
| `npm run loadtest` | The standalone 20-player load test (section 7) |
| `npm run typecheck` | Type-check all code |
| `npm run cards` | Regenerate the UNO card images |
