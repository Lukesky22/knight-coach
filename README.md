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
- **Move-by-move review.** Step through the game and every one of your moves gets a verdict
  (best / excellent / good / inaccuracy / mistake / blunder / missed win). When there was
  something better, the board draws your move in red and the engine's in green, and you get:
  - a plain-English reason it failed, derived from the engine's own refutation rather than
    from any language model: which piece hangs, what recaptures, what gets forked, what the
    forced mate is
  - **Watch the better line** - rewinds a ply and plays the engine's continuation out on the
    board, so the improvement is something you see rather than notation you decode
  - **Try it yourself** - hands you the position back and makes you find the move
- Live positional commentary on whatever position is in front of you: pieces you are leaving
  hanging, loose enemy pieces worth grabbing, an uncastled king past move 8, being squeezed
  on mobility, and material imbalance with the plan that follows from it
- A game report with your clean-move percentage, a tally of every move quality, and the two
  or three turning points as buttons that jump straight to the position
- Coach's notes across all analysed games: average centipawn loss, which phase of the game
  you err in most, how often your mistakes are punished immediately, and whether an opening
  really does go worse than your own baseline
- **Training**: your own blunders served back as puzzles. The position comes up cold, you
  play a move on the board, and the engine grades it — a move it rates within half a pawn
  of its own choice counts as right. Positions you miss come back sooner (a five-box
  spaced-repetition ladder at 0/1/3/7/21 days); two clean finds in a row retires one.
- **Openings**: an opening-habits scorecard built from the PGNs alone (how often you castle
  and when, early queen sorties, pieces developed by move 10, central pawns, one piece
  shuffled repeatedly), a per-opening record showing the move where you personally leave
  known theory and what the book plays there, and a drill that plays real theory back at you
  move by move, naming the variation as you go. Every book deviation is cross-checked against
  the engine, so a sound unnamed transposition is reported as a naming gap, never as an error.
- Results are saved on the device, so a game is only ever analysed once
- The header shows when it last synced and whether anything new arrived

## Layout

```
app/
  index.html            shell
  css/app.css           all styling
  js/app.js             views, routing, replay, coach UI
  js/analysis.js        Stockfish pipeline (port of chess_review.py) + explanations
  js/trainer.js         puzzle queue and spaced repetition
  js/openings.js        opening book lookup, habits, per-opening report
  vendor/openings.json  3,810 named openings (lichess chess-openings, CC0)
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
