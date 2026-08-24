// Play a game against Stockfish, then review it with the same machinery that
// reviews your Chess.com games.
//
// Strength comes from Stockfish's own Skill Level option plus a shallow search,
// which is far more human than a full-strength engine told to move fast.

import { getEngine, resetEngine } from './analysis.js';

export const LEVELS = [
  { id: 0, name: 'Beginner',     skill: 0,  depth: 1,  elo: '~400' },
  { id: 1, name: 'Casual',       skill: 3,  depth: 2,  elo: '~700' },
  { id: 2, name: 'Club',         skill: 6,  depth: 4,  elo: '~1000' },
  { id: 3, name: 'Strong',       skill: 10, depth: 7,  elo: '~1400' },
  { id: 4, name: 'Very strong',  skill: 15, depth: 10, elo: '~1800' },
  { id: 5, name: 'Full strength', skill: 20, depth: 14, elo: '2500+' },
];

let appliedSkill = null;

/** Ask the engine for a move at the given level. Returns a UCI string. */
export async function engineMove(fen, level) {
  const eng = await getEngine();
  if (appliedSkill !== level.skill) {
    eng.send(`setoption name Skill Level value ${level.skill}`);
    appliedSkill = level.skill;
  }
  const res = await eng.evalPosition(fen, level.depth);
  return res.pv && res.pv.length ? res.pv[0] : null;
}

/**
 * Put the engine back to full strength. The same worker is shared with game
 * review, so leaving Skill Level at 3 would quietly weaken every analysis.
 */
export function releaseEngine() {
  if (appliedSkill !== null && appliedSkill !== 20) {
    resetEngine();
    appliedSkill = null;
  }
}

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
