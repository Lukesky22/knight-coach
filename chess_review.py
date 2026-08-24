# chess_review.py  (v1)
# Usage:  python chess_review.py mygame.pgn
# Output: mygame_review.md next to the PGN.
#
# Pipeline (matches the spec):
#   1. read the move list from the PGN
#   2. replay it on a board in memory, one pass
#   3. Stockfish evaluates every position at fixed DEPTH (the notebook)
#   4. drop = cp lost by the mover; flag if >= THRESHOLD or mate involved
#   5. optional: Claude explains each flagged move (needs ANTHROPIC_API_KEY)
#   6. write one Markdown report, flagged moves sorted worst first

import os
import sys
import shutil

import chess
import chess.engine
import chess.pgn

# ---------------- tuning knobs ----------------
STOCKFISH_PATH = "stockfish"   # or the full path to the binary
DEPTH = 18                     # search depth: same rigor for all 81 positions
THRESHOLD = 80                 # centipawns lost that flag a move (your 80)
USERNAME = "your_chesscom_name"  # <-- EDIT ME: only your moves get reviewed
PV_MOVES = 4                   # how many moves of the best line to show
MATE_CP = 100000               # numeric stand-in for "mate" scores
LLM_MODEL = "claude-sonnet-4-6"
# ----------------------------------------------


def find_stockfish():
    """Return a runnable stockfish path or exit with a clear message."""
    candidates = [STOCKFISH_PATH, "/usr/games/stockfish",
                  "/opt/homebrew/bin/stockfish", "/usr/local/bin/stockfish"]
    for c in candidates:
        if shutil.which(c) or os.path.isfile(c):
            return c
    sys.exit("Stockfish not found. Install it, or set STOCKFISH_PATH "
             "at the top of this file to the full path of the binary.")


def eval_white(info):
    """Stockfish's answer converted to White's viewpoint, as one integer.
    Mate scores become huge integers near +/-MATE_CP so the drop
    formula flags them automatically (spec: mate allowed/missed = flag)."""
    return info["score"].white().score(mate_score=MATE_CP)


def fmt(cp):
    """Pretty-print an eval: '+0.40' in pawns, or 'M3' for mate in 3."""
    if abs(cp) >= MATE_CP - 500:
        n = MATE_CP - abs(cp)
        return f"{'M' if cp > 0 else '-M'}{n}"
    return f"{cp / 100:+.2f}"


def analyze_game(pgn_path):
    with open(pgn_path, encoding="utf-8", errors="ignore") as f:
        game = chess.pgn.read_game(f)
    if game is None:
        sys.exit("Could not read a game from this PGN file.")

    white = game.headers.get("White", "?")
    black = game.headers.get("Black", "?")
    my_color = None                      # None = review both sides
    if USERNAME.lower() == white.lower():
        my_color = chess.WHITE
    elif USERNAME.lower() == black.lower():
        my_color = chess.BLACK
    else:
        print(f"USERNAME '{USERNAME}' not in headers ({white} vs {black}): "
              "reviewing both sides.")

    moves = list(game.mainline_moves())
    board = game.board()
    engine = chess.engine.SimpleEngine.popen_uci(find_stockfish())
    limit = chess.engine.Limit(depth=DEPTH)

    print(f"Analyzing {len(moves) + 1} positions at depth {DEPTH}...")
    info = engine.analyse(board, limit)
    prev_eval = eval_white(info)         # notebook entry for position 0
    prev_pv = info.get("pv", [])         # Stockfish's best line from here

    records = []
    for i, move in enumerate(moves, start=1):
        mover = board.turn
        label = f"{board.fullmove_number}{'.' if mover == chess.WHITE else '...'}"
        san = board.san(move)
        fen_before = board.fen()
        best_line = board.variation_san(prev_pv[:PV_MOVES]) if prev_pv else ""

        board.push(move)

        if board.is_checkmate():         # terminal position: no engine needed
            cur_eval = -MATE_CP if board.turn == chess.WHITE else MATE_CP
            cur_pv = []
        elif board.is_game_over(claim_draw=False):
            cur_eval, cur_pv = 0, []
        else:
            info = engine.analyse(board, limit)
            cur_eval = eval_white(info)
            cur_pv = info.get("pv", [])

        # drop = cp the mover gave away (both evals are White's viewpoint)
        drop = (prev_eval - cur_eval) if mover == chess.WHITE \
            else (cur_eval - prev_eval)

        records.append({
            "label": label, "san": san, "mover": mover,
            "mover_name": white if mover == chess.WHITE else black,
            "before": prev_eval, "after": cur_eval, "drop": drop,
            "fen_before": fen_before, "best_line": best_line,
        })
        prev_eval, prev_pv = cur_eval, cur_pv
        print(f"  position {i + 1}/{len(moves) + 1}", end="\r")

    engine.quit()
    print()

    flagged = [r for r in records
               if (my_color is None or r["mover"] == my_color)
               and r["drop"] >= THRESHOLD]
    flagged.sort(key=lambda r: r["drop"], reverse=True)
    return game, flagged


def explain_with_llm(flagged):
    """Fill r['explanation'] for each flagged move. Skips cleanly if no key."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("No ANTHROPIC_API_KEY set: skipping coach explanations.")
        return
    import anthropic
    client = anthropic.Anthropic()
    for r in flagged:
        prompt = (
            "You are a chess coach reviewing one move.\n"
            f"Position before the move (FEN): {r['fen_before']}\n"
            f"{r['mover_name']} played {r['label']} {r['san']}. "
            f"The evaluation went from {fmt(r['before'])} to {fmt(r['after'])} "
            f"(White's viewpoint), losing about {r['drop']} centipawns.\n"
            f"Stockfish's best line was: {r['best_line']}\n"
            "In 3 to 5 sentences, explain concretely why the played move "
            "fails (what tactic or threat it allows or misses) and why the "
            "best line is better. Plain text only."
        )
        try:
            msg = client.messages.create(
                model=LLM_MODEL, max_tokens=300,
                messages=[{"role": "user", "content": prompt}])
            r["explanation"] = msg.content[0].text.strip()
        except Exception as e:
            r["explanation"] = f"(explanation failed: {e})"


def write_report(pgn_path, game, flagged):
    h = game.headers
    out_path = os.path.splitext(pgn_path)[0] + "_review.md"
    lines = [
        f"# Game review: {h.get('White','?')} vs {h.get('Black','?')}",
        "",
        f"Result: {h.get('Result','?')}  |  Date: {h.get('Date','?')}  |  "
        f"Site: {h.get('Site','?')}",
        "",
        f"{len(flagged)} move(s) flagged "
        f"(threshold {THRESHOLD} cp, depth {DEPTH}), worst first.",
        "",
    ]
    for r in flagged:
        lines += [
            f"## {r['label']} {r['san']}  (lost {fmt(r['drop'])[1:] if r['drop'] < MATE_CP - 500 else 'a mate'}"
            f"{' pawns' if r['drop'] < MATE_CP - 500 else ''})",
            "",
            f"- Eval before: {fmt(r['before'])}  |  after: {fmt(r['after'])} "
            "(White's viewpoint)",
            f"- Stockfish preferred: {r['best_line'] or '(end of game)'}",
            f"- Position (FEN): `{r['fen_before']}`",
            "",
            r.get("explanation",
                  "(set ANTHROPIC_API_KEY to get coach explanations)"),
            "",
        ]
    if not flagged:
        lines.append("No moves lost 80+ centipawns. Clean game.")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return out_path


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python chess_review.py mygame.pgn")
    pgn_path = sys.argv[1]
    game, flagged = analyze_game(pgn_path)
    explain_with_llm(flagged)
    out = write_report(pgn_path, game, flagged)
    print(f"Report written: {out}")


if __name__ == "__main__":
    main()
