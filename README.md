# Knight Coach

A personal chess review app. Free, no accounts, no server, no subscriptions. It fetches
your games from Chess.com, analyses them with Stockfish running inside the browser, and
coaches you on what you got wrong.

You type your Chess.com username in on first launch; it is stored on your own device and
never leaves it, along with every analysis result.

Everything lives in `app/`. It is a plain static website — no build step.

## Run it on this PC

```
npx http-server app -p 4173 -c-1
```

Then open <http://localhost:4173>.

(Claude Code can also start it with the `knightcoach` entry in `.claude/launch.json`.)

## Run it on the iPhone

The phone needs to reach the app at some address. Two private ways to do that:

### Option 1 — home Wi-Fi only (nothing on the internet)

The PC must be switched on and running the server, and the phone must be on the same Wi-Fi.

1. In an **Administrator** PowerShell, mark the home network private and open the port
   (substitute your own Wi-Fi name):

   ```
   Set-NetConnectionProfile -Name "YOUR-WIFI-NAME" -NetworkCategory Private
   New-NetFirewallRule -DisplayName "Knight Coach" -Direction Inbound -Protocol TCP -LocalPort 4173 -Action Allow -Profile Private
   ```

2. Find the PC's address on the network with `ipconfig`, then open Safari on the phone
   and go to `http://THAT-ADDRESS:4173`.
3. Share button -> **Add to Home Screen**.

Offline mode does not work over plain `http`, so the app needs the PC running each time.

### Option 2 — private site on the internet (works anywhere, PC off)

Host the `app/` folder on Cloudflare Pages (free) and put Cloudflare Access in front of it
(also free for personal use). The site then asks for an email code and only lets in the
address you allow. Needs a free Cloudflare account.

### Option 3 — GitHub Pages

What this repo does. `.github/workflows/deploy.yml` publishes the `app/` folder on every
push to `main`. The site is public, but it holds no personal data: it is an empty app until
someone types a username in, and it stores what it finds on that person's own device.

## What it does

- Fetches every game from the Chess.com public API (no key needed) and caches past months
- Record, rating graph, and win/loss by opening
- Tap a game: replay it move by move, with an eval bar and eval graph
- **Analyze**: Stockfish evaluates every position; any move losing 80+ centipawns is flagged
  as inaccuracy / mistake / blunder, sorted worst-first, with the line you should have played
- Red arrow = what you played, green arrow = what Stockfish wanted
- Coach's notes across all analysed games: average centipawn loss, which phase of the game
  you err in most, and which openings leak the most points
- Results are saved on the device, so a game is only ever analysed once

## Layout

```
app/
  index.html            shell
  css/app.css           all styling
  js/app.js             views, routing, replay, coach UI
  js/analysis.js        Stockfish pipeline (port of chess_review.py)
  js/chesscom.js        Chess.com API + month caching
  js/board.js           board renderer and arrows
  js/db.js              IndexedDB wrapper
  vendor/               chess.js + Stockfish 18 WASM (lite, single-threaded)
  pieces/               cburnett SVG pieces (GPL-2.0, from lichess)
chess_review.py         the original desktop script this app grew out of
```

`chess_review.py` still works on its own for a single PGN, and can add written
explanations from Claude if `ANTHROPIC_API_KEY` is set. The app deliberately leaves that
out, because it is the one part that is not free.

## Tuning

Depth 14 is the default (about 10 seconds a game). Raise it to 16-18 for stronger analysis
and slower runs; the picker is on the home screen and in each game.
