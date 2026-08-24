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

let enginePromise = null;

const DEFAULT_SKILL = 20;      // full strength; Play mode passes its own
const EVAL_TIMEOUT_MS = 120000; // a wedged worker must not hang the UI forever

class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.lineHandler = null;
    this.appliedSkill = null;
    this.dead = false;
    this.queue = Promise.resolve();
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (this.lineHandler) this.lineHandler(line);
    };
  }

  send(cmd) {
    if (!this.dead) this.worker.postMessage(cmd);
  }

  /**
   * The worker speaks one conversation at a time: a second `go` while the first
   * is running would steal its handler and leave the first caller waiting for a
   * `bestmove` that already went elsewhere. Every request is therefore queued
   * and runs to completion before the next one starts.
   */
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  waitFor(pred, ms = EVAL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lineHandler = null;
        reject(new Error('engine timed out'));
      }, ms);
      this.lineHandler = (line) => {
        const hit = pred(line);
        if (hit) {
          clearTimeout(timer);
          this.lineHandler = null;
          resolve(hit);
        }
      };
    });
  }

  init() {
    return this.enqueue(async () => {
      const ready = this.waitFor((l) => l === 'uciok');
      this.send('uci');
      await ready;
      this.send('setoption name Threads value 1');
      const ok = this.waitFor((l) => l === 'readyok');
      this.send('isready');
      await ok;
    });
  }

  // Returns {type: 'cp'|'mate', value, pv: [uci...]} from the side-to-move's view.
  // `skill` is per request: analysis always searches at full strength even if a
  // practice game against a weak level is still open in another view.
  evalPosition(fen, depth, opts = {}) {
    const skill = opts.skill == null ? DEFAULT_SKILL : opts.skill;
    return this.enqueue(() => this.runEval(fen, depth, skill));
  }

  runEval(fen, depth, skill) {
    return new Promise((resolve, reject) => {
      if (this.dead) {
        reject(new Error('engine stopped'));
        return;
      }
      if (this.appliedSkill !== skill) {
        this.send(`setoption name Skill Level value ${skill}`);
        this.appliedSkill = skill;
      }
      let best = null;
      const timer = setTimeout(() => {
        this.lineHandler = null;
        reject(new Error('engine timed out'));
      }, EVAL_TIMEOUT_MS);
      this.lineHandler = (line) => {
        if (line.startsWith('info ') && line.includes(' pv ') && !/bound/.test(line)) {
          const sc = line.match(/ score (cp|mate) (-?\d+)/);
          const pv = line.match(/ pv (.+)$/);
          if (sc && pv) best = { type: sc[1], value: parseInt(sc[2], 10), pv: pv[1].split(' ') };
        } else if (line.startsWith('bestmove')) {
          clearTimeout(timer);
          this.lineHandler = null;
          resolve(best || { type: 'cp', value: 0, pv: [] });
        }
      };
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  destroy() {
    this.dead = true;
    this.lineHandler = null;
    this.worker.terminate();
  }
}

// One shared worker. The promise is cached, not the instance, so two callers
// racing at startup cannot each build their own engine.
export function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const e = new Engine();
      await e.init();
      return e;
    })().catch((err) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

export function resetEngine() {
  const pending = enginePromise;
  enginePromise = null;
  if (pending) pending.then((e) => e.destroy(), () => {});
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

// How much a move cost, in words. Mate scores are huge sentinel integers, so
// they must never be printed as a number of pawns.
export function dropDescription(rec) {
  const mateBefore = isMateScore(rec.before);
  const mateAfter = isMateScore(rec.after);
  if (mateBefore || mateAfter) {
    const hadMate = mateBefore && (rec.before > 0 === (rec.mover === 'w'));
    return hadMate ? 'threw away a forced mate' : 'allowed a forced mate';
  }
  return `cost you ${(rec.drop / 100).toFixed(1)} pawns`;
}

/** Did the player actually play the move the engine wanted? */
export function playedBestMove(rec) {
  if (!rec.bestUci || !rec.played) return false;
  return rec.bestUci.slice(0, 4) === `${rec.played.from}${rec.played.to}`;
}

/** Was there only one legal move? Nobody can be blamed for a forced reply. */
export function onlyLegalMove(rec) {
  if (!rec.fenBefore) return false;
  try {
    return new Chess(rec.fenBefore).moves().length === 1;
  } catch {
    return false;
  }
}

/**
 * A move the engine itself recommended, or the only move on the board, is never
 * the player's error - however far the evaluation fell. Without this, a forced
 * king move into a lost position is reported as a blunder and then recommended
 * as the improvement in the very next sentence.
 */
export function isExonerated(rec) {
  if (rec.exonerated != null) return rec.exonerated;
  return playedBestMove(rec) || onlyLegalMove(rec);
}

export function severity(rec) {
  if (rec.drop < THRESHOLD) return null;
  if (isExonerated(rec)) return null;
  const mate = isMateScore(rec.before) || isMateScore(rec.after);
  if (mate || rec.drop >= 300) return 'blunder';
  if (rec.drop >= 150) return 'mistake';
  return 'inaccuracy';
}

// "opening" | "middlegame" | "endgame" - simple heuristic used for coach stats
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

// ---------- per-move verdicts and positional commentary ----------

/**
 * A label for every move, not just the bad ones - stepping through a game
 * should tell you when you found the right idea as well as when you missed it.
 */
export function classify(rec) {
  if (isExonerated(rec)) return 'best';
  const mateSwing = isMateScore(rec.before) || isMateScore(rec.after);
  if (mateSwing && rec.drop >= THRESHOLD) {
    const hadMate = isMateScore(rec.before) && (rec.before > 0 === (rec.mover === 'w'));
    return hadMate ? 'missed-win' : 'blunder';
  }
  if (rec.drop >= 300) return 'blunder';
  if (rec.drop >= 150) return 'mistake';
  if (rec.drop >= THRESHOLD) return 'inaccuracy';
  if (rec.drop <= 20) return 'excellent';
  return 'good';
}

export const VERDICT_LABEL = {
  best: 'Best move',
  excellent: 'Excellent',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
  'missed-win': 'Missed win',
};

/**
 * Pieces of `color` that the opponent can profitably take right now: either the
 * square is undefended, or the capture wins material outright.
 */
export function hangingFor(fen, color) {
  const parts = fen.split(' ');
  const opponent = color === 'w' ? 'b' : 'w';
  if (parts[1] !== opponent) {
    parts[1] = opponent;
    parts[3] = '-';
  }
  let probe;
  try { probe = new Chess(parts.join(' ')); } catch { return []; }

  const found = [];
  for (const m of probe.moves({ verbose: true })) {
    if (!m.captured) continue;
    const gain = VALUE[m.captured] - VALUE[m.piece];
    let hanging = false;
    try {
      const after = new Chess(probe.fen());
      after.move({ from: m.from, to: m.to, promotion: 'q' });
      const canRecapture = after.moves({ verbose: true }).some((r) => r.to === m.to);
      hanging = !canRecapture ? VALUE[m.captured] >= 1 : gain > 0;
    } catch { hanging = gain > 0; }
    if (hanging && !found.some((f) => f.square === m.to)) {
      found.push({ square: m.to, piece: NAME[m.captured], by: m.san, value: VALUE[m.captured] });
    }
  }
  return found.sort((a, b) => b.value - a.value);
}

function castledOrKingSafe(fen, color) {
  const board = fen.split(' ')[0].split('/');
  const kingChar = color === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of board[r]) {
      if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
      if (ch === kingChar) {
        const rank = 8 - r;
        const homeRank = color === 'w' ? 1 : 8;
        // still on the back rank in the middle three files = uncastled
        return !(rank === homeRank && file >= 3 && file <= 5);
      }
      file++;
    }
  }
  return true;
}

/**
 * Plain observations about the position in front of you - the sort of thing a
 * coach says out loud while you both look at the board.
 */
export function positionNotes(fen, color, fullmove) {
  const notes = [];
  let chess;
  try { chess = new Chess(fen); } catch { return notes; }

  const hanging = hangingFor(fen, color);
  if (hanging.length) {
    const h = hanging[0];
    notes.push({
      kind: 'warn',
      text: `Your ${h.piece} on ${h.square} can be taken by ${h.by}. Deal with it before doing anything else.`,
    });
  }

  const theirs = hangingFor(fen, color === 'w' ? 'b' : 'w');
  if (theirs.length && theirs[0].value >= 3) {
    notes.push({
      kind: 'good',
      text: `Their ${theirs[0].piece} on ${theirs[0].square} is loose - look for a way to win it.`,
    });
  }

  if (fullmove >= 8 && !castledOrKingSafe(fen, color)) {
    notes.push({ kind: 'warn', text: 'Your king is still uncastled in the middle. Castling is usually the most valuable move available.' });
  }

  // whose pieces are doing more work
  const mine = new Chess(fen);
  if (mine.turn() !== color) {
    const p = fen.split(' ');
    p[1] = color; p[3] = '-';
    try { mine.load(p.join(' ')); } catch { /* keep original */ }
  }
  const myMoves = mine.moves().length;
  const flip = fen.split(' ');
  flip[1] = color === 'w' ? 'b' : 'w';
  flip[3] = '-';
  let theirMoves = null;
  try { theirMoves = new Chess(flip.join(' ')).moves().length; } catch { /* ignore */ }
  if (theirMoves && myMoves && theirMoves > myMoves * 1.6 && fullmove >= 8) {
    notes.push({ kind: 'warn', text: `Their pieces have ${theirMoves} moves to your ${myMoves}. You are being squeezed - trade something off or open a line.` });
  }

  const mat = material(fen);
  const diff = color === 'w' ? mat.w - mat.b : mat.b - mat.w;
  if (Math.abs(diff) >= 2) {
    notes.push({
      kind: diff > 0 ? 'good' : 'warn',
      text: diff > 0
        ? `You are ${diff} points of material up. Trade pieces, keep it simple, and head for the endgame.`
        : `You are ${-diff} points down. Avoid trades and look for complications.`,
    });
  }
  return notes;
}

// ---------- explaining WHY a move was bad ----------

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function material(fen) {
  const board = fen.split(' ')[0];
  let w = 0, b = 0;
  for (const ch of board) {
    const v = VALUE[ch.toLowerCase()];
    if (v === undefined) continue;
    if (ch === ch.toUpperCase()) w += v; else b += v;
  }
  return { w, b };
}

// After `mv` lands on a square, does the piece now standing there attack two or
// more valuable enemy pieces? That's a fork.
//
// The refutation has already been played, so it is the victim's turn and
// chess.js would enumerate the wrong side's moves. Hand it back a copy of the
// position with the turn flipped so we can ask what the mover threatens.
function forkTargets(fenAfterRefutation, toSquare) {
  const parts = fenAfterRefutation.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-'; // an en-passant square is meaningless once the turn flips
  let probe;
  try {
    probe = new Chess(parts.join(' '));
  } catch {
    return [];
  }
  const targets = [];
  for (const m of probe.moves({ verbose: true })) {
    if (m.from === toSquare && m.captured && VALUE[m.captured] >= 3) {
      targets.push(m.captured);
    }
  }
  return targets;
}

/**
 * Plain-English reason a flagged move was bad, derived from the engine's own
 * refutation rather than from any language model.
 *
 * @param rec   the flagged record
 * @param next  the record for the opponent's reply (holds the refutation PV
 *              and the position immediately after `rec` was played)
 */
/**
 * What the engine's move actually achieves, in words. Naming the move alone
 * ("best was Be6") teaches nothing - the point is the idea behind it.
 */
export function describeBestMove(rec) {
  if (!rec.bestUci) return '';
  let chess, mv;
  try {
    chess = new Chess(rec.fenBefore);
    mv = chess.move({
      from: rec.bestUci.slice(0, 2),
      to: rec.bestUci.slice(2, 4),
      promotion: rec.bestUci[4] || 'q',
    });
  } catch { return ''; }
  if (!mv) return '';

  const san = mv.san;
  const wasHanging = hangingFor(rec.fenBefore, rec.mover);
  const stillHanging = hangingFor(chess.fen(), rec.mover);
  const rescued = wasHanging.find((h) => !stillHanging.some((s) => s.square === h.square));

  let idea;
  if (mv.san === 'O-O' || mv.san === 'O-O-O') {
    idea = 'tucks your king away and connects the rooks';
  } else if (mv.captured) {
    idea = `takes the ${NAME[mv.captured]} on ${mv.to}`;
  } else if (rescued) {
    idea = rescued.square === mv.from
      ? `moves your ${rescued.piece} out of danger`
      : `defends your ${rescued.piece} on ${rescued.square}`;
  } else if (san.includes('+')) {
    idea = 'gives check, so you get a free move to sort the position out';
  } else if (mv.piece === 'p' && ['d', 'e'].includes(mv.to[0])) {
    idea = 'takes space in the centre and opens lines for your pieces';
  } else if (['n', 'b'].includes(mv.piece) && /[18]/.test(mv.from[1])) {
    idea = 'brings a new piece into the game';
  } else {
    idea = 'keeps everything defended and leaves no target';
  }
  return `**${san}** was the move: it ${idea}.`;
}

/**
 * The sentence a coach says first: were you already in trouble before you
 * moved, and did the move address it? Missing an existing threat is a
 * different mistake from creating a new weakness, and they need different
 * fixes, so it is worth naming which one happened.
 */
function threatContext(rec) {
  const beforeMine = hangingFor(rec.fenBefore, rec.mover);
  if (!beforeMine.length) return '';
  const worst = beforeMine[0];
  // did the move rescue it?
  let after = null;
  try {
    const c = new Chess(rec.fenBefore);
    c.move({ from: rec.played.from, to: rec.played.to, promotion: 'q' });
    after = hangingFor(c.fen(), rec.mover);
  } catch { return ''; }
  const stillLoose = after && after.some((h) => h.piece === worst.piece);
  if (!stillLoose) return '';
  const moved = rec.played.from === worst.square;
  if (moved) return '';
  return `Your ${worst.piece} on ${worst.square} was already hanging before this, and ${rec.san} neither moves it nor defends it. `;
}

export function explainMistake(rec, next) {
  const best = describeBestMove(rec);
  const better = best ? ` ${best}` : '';
  const context = threatContext(rec);

  if (isMateScore(rec.after)) {
    const moverIsWinning = rec.after > 0 === (rec.mover === 'w');
    const n = MATE_CP - Math.abs(rec.after);
    if (!moverIsWinning) {
      const line = next?.bestLine ? ` The finish is ${next.bestLine.replace(/^\d+\.+\s*/, '')}.` : '';
      return `This walks into forced mate in ${n}.${line}${better}`;
    }
  }
  if (isMateScore(rec.before)) {
    const hadMate = rec.before > 0 === (rec.mover === 'w');
    if (hadMate) return `You had a forced mate here and let it slip.${better}`;
  }

  if (!next || !next.bestUci) {
    return `This drops ${(rec.drop / 100).toFixed(1)} pawns of advantage.${better}`;
  }

  // Replay the engine's refutation on the position left after the played move.
  let chess, refMove;
  try {
    chess = new Chess(next.fenBefore);
    refMove = chess.move({
      from: next.bestUci.slice(0, 2),
      to: next.bestUci.slice(2, 4),
      promotion: next.bestUci[4] || 'q',
    });
  } catch {
    return `This drops ${(rec.drop / 100).toFixed(1)} pawns.${better}`;
  }
  if (!refMove) return `This drops ${(rec.drop / 100).toFixed(1)} pawns.${better}`;

  const mine = rec.mover === 'w' ? 'w' : 'b';
  // Weigh the exchange from before your own move, and as a difference between
  // both sides. Counting only the material you lost makes an even trade read as
  // "3 points down", which fires on most captures.
  const balance = (fen) => {
    const m = material(fen);
    return mine === 'w' ? m.w - m.b : m.b - m.w;
  };
  const balanceBefore = balance(rec.fenBefore);

  if (refMove.captured) {
    const piece = NAME[refMove.captured];
    const recaptures = chess.moves({ verbose: true }).filter((m) => m.to === refMove.to);

    if (!recaptures.length) {
      const net = balanceBefore - balance(chess.fen());
      // Their capturing piece is still standing here, so a fork claim is real.
      const forks = forkTargets(chess.fen(), refMove.to);
      // "for nothing" has to be earned: measure the whole exchange from before
      // your own move. A capture you already paid for is a trade, not a gift.
      if (net >= 1) {
        const worth = net >= 9 ? 'the queen, for nothing'
          : net >= 5 ? 'a whole rook, for nothing'
          : net >= 3 ? 'a whole piece, for nothing'
          : net >= 2 ? `${net} points of material`
          : 'a free pawn';
        return `${context}${refMove.san} simply takes your ${piece} on ${refMove.to} and nothing can recapture — ${worth}.${better}`;
      }
      if (forks.length >= 2) {
        return `${context}${refMove.san} takes the ${piece} and forks your ${NAME[forks[0]]} and ${NAME[forks[1]]}, so another piece drops next move.${better}`;
      }
      return `${context}${refMove.san} takes on ${refMove.to}, and though the material comes out even you have nothing to take back with, leaving you ${(rec.drop / 100).toFixed(1)} pawns worse.${better}`;
    }
    // You can take back, so weigh the whole trade, not just their capture.
    // Recapturing with the cheapest piece is the normal choice.
    const cheapest = recaptures.sort((a, b) => VALUE[a.piece] - VALUE[b.piece])[0];
    chess.move({ from: cheapest.from, to: cheapest.to, promotion: 'q' });
    const net = balanceBefore - balance(chess.fen());

    if (net >= 2) {
      return `${context}${refMove.san} wins your ${piece} on ${refMove.to}. Even after you take back with the ${NAME[cheapest.piece]} you are about ${net} points of material down, which at this level usually decides the game on its own.${better}`;
    }
    return `${refMove.san} trades on ${refMove.to} with tempo and leaves you ${(rec.drop / 100).toFixed(1)} pawns worse.${better}`;
  }

  const forks = forkTargets(chess.fen(), refMove.to);
  if (forks.length >= 2) {
    return `${refMove.san} hits your ${NAME[forks[0]]} and ${NAME[forks[1]]} at once — you cannot save both.${better}`;
  }
  if (refMove.san.includes('+')) {
    return `${context}${refMove.san} comes with check, so you have to answer it before doing anything you wanted to do, and that costs about ${(rec.drop / 100).toFixed(1)} pawns.${better}`;
  }
  // A quiet refutation means the damage is positional: name what the opponent
  // is now threatening rather than leaving it at "you are worse".
  let threat = '';
  try {
    const afterRef = new Chess(chess.fen());
    const loose = hangingFor(afterRef.fen(), rec.mover);
    if (loose.length) {
      threat = ` It threatens ${loose[0].by}, winning your ${loose[0].piece} on ${loose[0].square}.`;
    }
  } catch { /* no extra detail */ }
  return `${context}${refMove.san} is quiet but strong: it leaves you about ${(rec.drop / 100).toFixed(1)} pawns worse with no clean way to untangle.${threat}${better}`;
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
    rec.exonerated = playedBestMove(rec) || onlyLegalMove(rec);
    rec.severity = severity(rec);
    records.push(rec);

    prevEval = curEval;
    prevPv = curPv;
    evals.push(curEval);
    if (onProgress) onProgress(i + 1, total);
  }

  const mine = myColor ? records.filter((r) => r.mover === myColor) : records;
  const flagged = mine.filter((r) => r.severity);
  flagged.sort((a, b) => b.drop - a.drop);

  const counts = { blunder: 0, mistake: 0, inaccuracy: 0 };
  for (const r of flagged) counts[r.severity]++;
  const acpl = mine.length
    ? Math.round(mine.reduce((s, r) => s + (r.exonerated ? 0 : Math.min(1000, Math.max(0, r.drop))), 0) / mine.length)
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
