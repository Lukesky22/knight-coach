// Play a game against Stockfish, then review it with the same machinery that
// reviews your Chess.com games.
//
// Strength comes from Stockfish's own Skill Level option plus a shallow search,
// which is far more human than a full-strength engine told to move fast.

import { getEngine } from './analysis.js';

// `choices` is how many candidate moves the engine keeps, and `spread` how many
// centipawns worse than its favourite a move may be and still get played. Those
// two are what stop every game being the same game: a fixed-depth search returns
// the same move from the same position every single time, so an opponent that
// always plays it is a recording, not a sparring partner.
// `think` is the [min, max] milliseconds a reply takes. A move that lands in
// 0.1s reads as a machine no matter how good it is.
export const LEVELS = [
  { id: 0, name: 'Beginner',     skill: 0,  depth: 1,  elo: '~400',  choices: 6, spread: 350, think: [500, 1400] },
  { id: 1, name: 'Casual',       skill: 3,  depth: 2,  elo: '~700',  choices: 5, spread: 220, think: [600, 1800] },
  { id: 2, name: 'Club',         skill: 6,  depth: 4,  elo: '~1000', choices: 4, spread: 130, think: [700, 2200] },
  { id: 3, name: 'Strong',       skill: 10, depth: 7,  elo: '~1400', choices: 3, spread: 70,  think: [900, 2600] },
  { id: 4, name: 'Very strong',  skill: 15, depth: 10, elo: '~1800', choices: 3, spread: 35,  think: [1000, 3000] },
  { id: 5, name: 'Full strength', skill: 20, depth: 14, elo: '2500+', choices: 1, spread: 0,  think: [1200, 3500] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Score from the side-to-move's view, mate folded into a large centipawn number. */
function scoreOf(line) {
  if (line.type === 'mate') {
    return line.value > 0 ? 100000 - line.value : -(100000 + line.value);
  }
  return line.value;
}

/**
 * Choose among the candidates the search kept. Everything within `spread` of the
 * best move is eligible, weighted so the good moves still come up most often —
 * the result varies game to game without the opponent throwing pieces away.
 */
export function chooseMove(lines, spread, rand = Math.random) {
  const usable = lines.filter((l) => l && l.pv && l.pv.length);
  if (!usable.length) return null;
  const scored = usable.map((l) => ({ uci: l.pv[0], score: scoreOf(l) }));
  const best = Math.max(...scored.map((c) => c.score));
  const pool = scored.filter((c) => best - c.score <= spread);
  if (pool.length === 1) return pool[0].uci;
  // Weight falls off with how much worse the move is, so the best stays likeliest.
  const weights = pool.map((c) => Math.max(1, spread - (best - c.score) + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i].uci;
  }
  return pool[pool.length - 1].uci;
}

/** Ask the engine for a move at the given level. Returns a UCI string. */
export async function engineMove(fen, level) {
  const eng = await getEngine();
  const started = Date.now();
  // Skill Level travels with the request. It is no longer sticky global state on
  // the shared worker, so abandoning a practice game mid-move cannot leave game
  // review running at Skill Level 6 and writing weakened verdicts to the database.
  const res = await eng.evalPosition(fen, level.depth, {
    skill: level.skill,
    multipv: level.choices || 1,
  });
  const uci = chooseMove(res.moves && res.moves.length ? res.moves : [res], level.spread || 0);
  // Spend the rest of the thinking time. The search at these depths is close to
  // instant, and a reply that appears the moment you let go of the piece is the
  // single thing that makes the opponent feel like a machine.
  const [lo, hi] = level.think || [400, 1200];
  const want = lo + Math.random() * (hi - lo);
  const left = want - (Date.now() - started);
  if (left > 0) await sleep(left);
  return uci;
}

/**
 * Kept for callers that tidy up when a practice game ends. Strength is now
 * per request, so there is no longer any engine state to put back.
 */
export function releaseEngine() {}

/** A PGN the review pipeline can read back. */
export function buildPgn({ sans, myColor, level, result }) {
  const white = myColor === 'w' ? 'You' : `Stockfish (${level.name})`;
  const black = myColor === 'b' ? 'You' : `Stockfish (${level.name})`;
  const body = [];
  for (let i = 0; i < sans.length; i += 2) {
    body.push(`${i / 2 + 1}. ${sans[i]}${sans[i + 1] ? ` ${sans[i + 1]}` : ''}`);
  }
  return [
    '[Event "Practice game"]',
    '[Site "Knight Coach"]',
    `[White "${white}"]`,
    `[Black "${black}"]`,
    `[Result "${result}"]`,
    '',
    `${body.join(' ')} ${result}`,
    '',
  ].join('\n');
}

export function outcomeOf(chess) {
  if (chess.isCheckmate()) {
    return { over: true, result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  }
  if (chess.isStalemate()) return { over: true, result: '1/2-1/2', reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { over: true, result: '1/2-1/2', reason: 'repetition' };
  if (chess.isDraw()) return { over: true, result: '1/2-1/2', reason: 'the fifty-move rule' };
  return { over: false };
}
