// In-browser port of chess_review.py:
//   1. replay the PGN
//   2. Stockfish (WASM worker) evaluates every position at fixed depth
//   3. drop = cp lost by the mover (White's viewpoint), flag if >= THRESHOLD
//   4. mate scores become +/-(MATE_CP - n) so the same formula flags them

import { Chess } from '../vendor/chess.js';

export const MATE_CP = 100000;
export const THRESHOLD = 80;
const PV_MOVES = 4;
const ENGINE_URL = 'vendor/sf/stockfish-18-lite-single.js';

// ---------- engine worker ----------

let engine = null;

class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.lineHandler = null;
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (this.lineHandler) this.lineHandler(line);
    };
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  waitFor(pred) {
    return new Promise((resolve) => {
      this.lineHandler = (line) => {
        const hit = pred(line);
        if (hit) { this.lineHandler = null; resolve(hit); }
      };
    });
  }

  async init() {
    const ready = this.waitFor((l) => l === 'uciok');
    this.send('uci');
    await ready;
    this.send('setoption name Threads value 1');
    const ok = this.waitFor((l) => l === 'readyok');
    this.send('isready');
    await ok;
  }

  // Returns {type: 'cp'|'mate', value, pv: [uci...]} from the side-to-move's view.
  evalPosition(fen, depth) {
    return new Promise((resolve) => {
      let best = null;
      this.lineHandler = (line) => {
        if (line.startsWith('info ') && line.includes(' pv ') && !/bound/.test(line)) {
          const s = line.match(/ score (cp|mate) (-?\d+)/);
          const pv = line.match(/ pv (.+)$/);
          if (s && pv) best = { type: s[1], value: parseInt(s[2], 10), pv: pv[1].split(' ') };
        } else if (line.startsWith('bestmove')) {
          this.lineHandler = null;
          resolve(best || { type: 'cp', value: 0, pv: [] });
        }
      };
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  destroy() {
    this.worker.terminate();
  }
}

export async function getEngine() {
  if (!engine) {
    engine = new Engine();
    await engine.init();
  }
  return engine;
}

export function resetEngine() {
  if (engine) engine.destroy();
  engine = null;
}

// ---------- score plumbing (mirrors the Python) ----------

// Convert an stm-relative UCI score to one White-viewpoint integer,
// like python-chess score.white().score(mate_score=MATE_CP).
function toWhiteView(res, stm) {
  let v;
  if (res.type === 'cp') v = res.value;
  else v = res.value > 0 ? MATE_CP - res.value : -(MATE_CP + res.value);
  return stm === 'w' ? v : -v;
}

export function fmtEval(cp) {
  if (Math.abs(cp) >= MATE_CP - 500) {
    const n = MATE_CP - Math.abs(cp);
    return `${cp > 0 ? 'M' : '-M'}${n}`;
  }
  return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
}

export function isMateScore(cp) {
  return Math.abs(cp) >= MATE_CP - 500;
}

export function severity(rec) {
  if (rec.drop < THRESHOLD) return null;
  const mate = isMateScore(rec.before) || isMateScore(rec.after);
  if (mate || rec.drop >= 300) return 'blunder';
  if (rec.drop >= 150) return 'mistake';
  return 'inaccuracy';
}

// "opening" | "middlegame" | "endgame" — simple heuristic used for coach stats
function phaseOf(fen, fullmove) {
  if (fullmove <= 10) return 'opening';
  const pieces = fen.split(' ')[0].replace(/[^nbrqNBRQ]/g, '').length;
  return pieces <= 6 ? 'endgame' : 'middlegame';
}

// UCI pv -> numbered SAN line starting from fen, like board.variation_san()
function pvToSan(fen, pv, maxMoves) {
  if (!pv || !pv.length) return '';
  const c = new Chess(fen);
  const parts = [];
  for (const uci of pv.slice(0, maxMoves)) {
    const fullmove = parseInt(c.fen().split(' ')[5], 10);
    const white = c.turn() === 'w';
    let mv;
    try {
      mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      break;
    }
    if (white) parts.push(`${fullmove}. ${mv.san}`);
    else if (!parts.length) parts.push(`${fullmove}... ${mv.san}`);
    else parts.push(mv.san);
  }
  return parts.join(' ');
}

export function parseGame(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const moves = chess.history({ verbose: true });
  const startFen = moves.length ? moves[0].before : chess.fen();
  const headers = chess.getHeaders ? chess.getHeaders() : chess.header();
  return { moves, startFen, headers };
}

// ---------- the main pipeline ----------

export async function analyzeGame({ pgn, myColor, depth, onProgress, signal }) {
  const { moves, startFen } = parseGame(pgn);
  const eng = await getEngine();
  const total = moves.length + 1;

  const checkAborted = () => {
    if (signal && signal.aborted) {
      resetEngine(); // kill mid-search cleanly; next analysis boots a fresh worker
      const err = new Error('cancelled');
      err.cancelled = true;
      throw err;
    }
  };

  if (onProgress) onProgress(0, total);
  let info = await eng.evalPosition(startFen, depth);
  checkAborted();
  let prevEval = toWhiteView(info, startFen.split(' ')[1]);
  let prevPv = info.pv;
  const evals = [prevEval];
  const records = [];

  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    const mover = mv.color;
    const fullmove = parseInt(mv.before.split(' ')[5], 10);
    const label = `${fullmove}${mover === 'w' ? '.' : '...'}`;

    const after = new Chess(mv.after);
    let curEval, curPv;
    if (after.isCheckmate()) {
      curEval = after.turn() === 'w' ? -MATE_CP : MATE_CP;
      curPv = [];
    } else if (after.isGameOver()) {
      curEval = 0;
      curPv = [];
    } else {
      info = await eng.evalPosition(mv.after, depth);
      checkAborted();
      curEval = toWhiteView(info, 'w' === mv.after.split(' ')[1] ? 'w' : 'b');
      curPv = info.pv;
    }

    const drop = mover === 'w' ? prevEval - curEval : curEval - prevEval;

    const rec = {
      i: i + 1, // position index after this move (0 = start position)
      label,
      san: mv.san,
      mover,
      before: prevEval,
      after: curEval,
      drop,
      fenBefore: mv.before,
      played: { from: mv.from, to: mv.to },
      bestUci: prevPv && prevPv.length ? prevPv[0] : null,
      bestLine: pvToSan(mv.before, prevPv, PV_MOVES),
      phase: phaseOf(mv.before, fullmove),
    };
    rec.severity = severity(rec);
    records.push(rec);

    prevEval = curEval;
    prevPv = curPv;
    evals.push(curEval);
    if (onProgress) onProgress(i + 1, total);
  }

  const mine = myColor ? records.filter((r) => r.mover === myColor) : records;
  const flagged = mine.filter((r) => r.drop >= THRESHOLD);
  flagged.sort((a, b) => b.drop - a.drop);

  const counts = { blunder: 0, mistake: 0, inaccuracy: 0 };
  for (const r of flagged) counts[r.severity]++;
  const acpl = mine.length
    ? Math.round(mine.reduce((s, r) => s + Math.min(1000, Math.max(0, r.drop)), 0) / mine.length)
    : 0;

  return {
    depth,
    analyzedAt: Date.now(),
    evals,
    records,
    flaggedIdx: flagged.map((r) => r.i),
    summary: { counts, acpl, moves: mine.length },
  };
}
