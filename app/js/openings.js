// Opening coaching.
//
// Two independent sources of truth, neither of which costs anything:
//   1. a vendored book of 3,810 named openings (lichess chess-openings, CC0),
//      used to say where you left known theory and what the alternatives were
//   2. your own games, used for the opening principles that actually decide
//      games at club level - castling late, walking the queen out early,
//      leaving pieces at home, shuffling one piece around

import { Chess } from '../vendor/chess.js';

let BOOK = null;
// prefix -> Map(nextSan -> opening name), so a lookup is one hash hit rather
// than a scan of 3,810 lines. Matters on a phone, where this runs per game.
let NEXT = null;
// exact line -> the name of the opening it reaches
let NAMED = null;

export async function loadBook() {
  if (BOOK) return BOOK;
  const res = await fetch('vendor/openings.json');
  BOOK = await res.json(); // [[eco, name, "e4 c5 Nf3"], ...]

  NEXT = new Map();
  NAMED = new Map();
  for (const [eco, name, line] of BOOK) {
    const moves = line ? line.split(' ') : [];
    NAMED.set(line, { eco, name, depth: moves.length });
    for (let i = 0; i < moves.length; i++) {
      const prefix = moves.slice(0, i).join(' ');
      let m = NEXT.get(prefix);
      if (!m) { m = new Map(); NEXT.set(prefix, m); }
      const cur = m.get(moves[i]);
      // `weight` counts how many named lines run through this move. A move the
      // whole book is built on (1.e4) outranks a curiosity (1.Nh3), which is
      // what makes a drill play main lines instead of novelties.
      if (cur) cur.weight++;
      else m.set(moves[i], { name, weight: 1, names: [name] });
      if (cur && cur.names.length < 24) cur.names.push(name);
    }
  }
  return BOOK;
}

/**
 * The book move to play from here, preferring main lines and, when a family is
 * given, continuations that actually stay inside that opening.
 */
export function pickBookMove(sans, family = '', rand = Math.random) {
  const { continuations } = bookAt(sans);
  if (!continuations.length) return null;
  const inFamily = family
    ? continuations.filter((c) => c.names.some((n) => n.startsWith(family)))
    : [];
  const pool = inFamily.length ? inFamily : continuations;
  // Weighted draw, not the single heaviest move. Always taking the top line
  // means drilling the Sicilian plays the identical game every time; drawing at
  // random lets real branches happen.
  //
  // Two corrections to a plain weighted draw, both so a drill still teaches
  // theory: the weight is squared, so main lines dominate rather than merely
  // leading, and anything under a twentieth of the most-played move is dropped
  // as a novelty. Without that floor, a Sicilian drill answers 1...c5 with 2.Nh3.
  const heaviest = pool.reduce((a, c) => Math.max(a, c.weight), 0);
  const floor = heaviest / 20;
  const main = pool.filter((c) => c.weight >= floor);
  const draw = main.length ? main : pool;
  const w = (c) => c.weight * c.weight;
  const total = draw.reduce((a, c) => a + w(c), 0);
  let roll = rand() * total;
  for (const c of draw) {
    roll -= w(c);
    if (roll <= 0) return c;
  }
  return draw[draw.length - 1];
}

/**
 * What the book knows about a position reached by `sans`: the deepest opening
 * name that matches this exact line, and the moves theory plays from here.
 */
export function bookAt(sans) {
  if (!NEXT) return { name: null, eco: null, depth: 0, continuations: [] };
  // walk back to the deepest named line that this position sits on
  let named = null;
  for (let i = sans.length; i >= 0 && !named; i--) {
    named = NAMED.get(sans.slice(0, i).join(' ')) || null;
  }
  const next = NEXT.get(sans.join(' '));
  return {
    name: named ? named.name : null,
    eco: named ? named.eco : null,
    depth: named ? named.depth : 0,
    continuations: next
      ? [...next.entries()]
          .map(([san, v]) => ({ san, name: v.name, weight: v.weight, names: v.names }))
          .sort((a, b) => b.weight - a.weight)
      : [],
  };
}

/**
 * The first ply where YOUR move left the book.
 *
 * `color` matters: a game leaving theory because the opponent played something
 * offbeat says nothing about your opening knowledge, so those plies are walked
 * through rather than reported.
 *
 * Returns null if you never left the book inside the window.
 */
export function bookExit(sans, color = null, maxPly = 24) {
  const limit = Math.min(sans.length, maxPly);
  for (let i = 0; i < limit; i++) {
    const info = bookAt(sans.slice(0, i));
    if (!info.continuations.length) return null; // book simply ran out
    if (info.continuations.some((c) => c.san === sans[i])) continue;
    const plyColor = i % 2 === 0 ? 'w' : 'b';
    if (color && plyColor !== color) return null; // they left theory, not you
    return {
      ply: i,
      moveNumber: Math.floor(i / 2) + 1,
      name: info.name,
      eco: info.eco,
      played: sans[i],
      expected: info.continuations.map((c) => c.san),
      line: sans.slice(0, i),
    };
  }
  return null;
}

// ---------------------------------------------------------------- recurring positions

/**
 * The positions this player actually keeps reaching, mined from their own
 * games. Generic theory drills teach lines; these are the crossroads of their
 * real chess life - "you have been here 14 times and score 32%".
 *
 * Keys merge transpositions (board + turn + castling, counters stripped), and
 * a shallow crossroads that nearly always leads to a kept deeper one is
 * absorbed by it: the deeper position IS the situation, told more precisely.
 */
export function recurringPositions(games, { minCount = 4, maxPly = 14, top = 10 } = {}) {
  const map = new Map();
  for (const g of games) {
    if (g.rules && g.rules !== 'chess') continue;
    let hist;
    try {
      const c = new Chess();
      c.loadPgn(g.pgn);
      hist = c.history({ verbose: true });
    } catch { continue; }
    const replay = new Chess();
    for (let ply = 0; ply < Math.min(hist.length, maxPly); ply++) {
      if (replay.turn() === g.myColor && ply >= 3) {
        const parts = replay.fen().split(' ');
        const key = `${parts[0]} ${parts[1]} ${parts[2]}`;
        let e = map.get(key);
        if (!e) {
          e = {
            key, fen: replay.fen(), color: g.myColor, ply,
            path: hist.slice(0, ply).map((m) => m.san),
            count: 0, W: 0, L: 0, D: 0, moves: new Map(),
          };
          map.set(key, e);
        }
        e.count++;
        e[g.resultForMe]++;
        const played = hist[ply].san;
        e.moves.set(played, (e.moves.get(played) || 0) + 1);
      }
      replay.move(hist[ply].san);
    }
  }

  const cands = [...map.values()].filter((e) => e.count >= minCount);
  cands.sort((a, b) => b.ply - a.ply || b.count - a.count);
  const kept = [];
  for (const e of cands) {
    const absorbed = kept.some((k) =>
      k.ply > e.ply
      && k.path.slice(0, e.ply).join(' ') === e.path.join(' ')
      && k.count >= 0.7 * e.count);
    if (!absorbed) kept.push(e);
  }
  for (const e of kept) {
    e.score = (e.W + e.D / 2) / e.count;
    // how much this position hurts: often reached, badly scored
    e.pain = e.count * (1 - e.score);
    e.usual = [...e.moves.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2);
  }
  kept.sort((a, b) => b.pain - a.pain);
  return kept.slice(0, top);
}

// ---------------------------------------------------------------- principles

const HOME = {
  w: { n: ['b1', 'g1'], b: ['c1', 'f1'], q: 'd1', k: 'e1' },
  b: { n: ['b8', 'g8'], b: ['c8', 'f8'], q: 'd8', k: 'e8' },
};

/**
 * Opening habits for one game, from the mover's point of view.
 * All measured over the first `window` full moves.
 */
export function gameHabits(pgn, color, window = 12) {
  const chess = new Chess();
  try { chess.loadPgn(pgn); } catch { return null; }
  const moves = chess.history({ verbose: true }).filter((m) => m.color === color);
  if (!moves.length) return null;

  const home = HOME[color];
  let castledOn = null;
  let queenOutOn = null;
  let developedBy10 = 0;
  let centerPawnBy6 = false;
  const developed = new Set();
  const pieceMoveCount = new Map();
  let repeatedPiece = null;

  moves.forEach((m, idx) => {
    const moveNo = idx + 1;
    if (moveNo > window) return;

    if ((m.san === 'O-O' || m.san === 'O-O-O') && castledOn === null) castledOn = moveNo;

    // a queen leaving its home square in the first handful of moves
    if (m.piece === 'q' && m.from === home.q && queenOutOn === null && moveNo <= 8) {
      queenOutOn = moveNo;
    }

    if ((m.piece === 'n' && home.n.includes(m.from)) || (m.piece === 'b' && home.b.includes(m.from))) {
      developed.add(m.from);
    }
    if (moveNo <= 10) developedBy10 = developed.size;

    if (moveNo <= 6 && m.piece === 'p' && ['d', 'e'].includes(m.to[0])) {
      const rank = parseInt(m.to[1], 10);
      if ((color === 'w' && rank >= 4) || (color === 'b' && rank <= 5)) centerPawnBy6 = true;
    }

    // track shuffling: same piece (by identity, following it around) moved a lot
    if (moveNo <= 10 && m.piece !== 'p') {
      let key = m.from;
      for (const [k, v] of pieceMoveCount) {
        if (v.at === m.from) { key = k; break; }
      }
      const cur = pieceMoveCount.get(key) || { n: 0, at: m.from, piece: m.piece };
      cur.n++;
      cur.at = m.to;
      pieceMoveCount.set(key, cur);
      if (cur.n >= 3 && !repeatedPiece) repeatedPiece = cur.piece;
    }
  });

  return {
    castledOn,
    queenOutOn,
    developedBy10: developed.size,
    centerPawnBy6,
    repeatedPiece,
  };
}

/** Aggregate habits across every game, with a verdict for each. */
export function habitReport(games) {
  const rows = [];
  let n = 0, castledTotal = 0, neverCastled = 0, castleSum = 0;
  let queenOut = 0, devSum = 0, noCenter = 0, shuffled = 0;

  for (const g of games) {
    const h = gameHabits(g.pgn, g.myColor);
    if (!h) continue;
    n++;
    if (h.castledOn) { castledTotal++; castleSum += h.castledOn; } else neverCastled++;
    if (h.queenOutOn) queenOut++;
    devSum += h.developedBy10;
    if (!h.centerPawnBy6) noCenter++;
    if (h.repeatedPiece) shuffled++;
  }
  if (!n) return [];

  const pct = (x) => Math.round((x / n) * 100);
  const avgCastle = castledTotal ? (castleSum / castledTotal).toFixed(1) : null;
  const avgDev = (devSum / n).toFixed(1);

  rows.push({
    key: 'castle',
    label: 'Castling',
    value: neverCastled ? `${pct(neverCastled)}% of games uncastled` : `always castles`,
    detail: avgCastle
      ? `When you do castle it is on move ${avgCastle}. Aim for move 8 or earlier.`
      : 'You are not castling at all.',
    good: pct(neverCastled) <= 15 && (!avgCastle || avgCastle <= 9),
  });
  rows.push({
    key: 'queen',
    label: 'Early queen',
    value: `${pct(queenOut)}% of games`,
    detail: 'Bringing the queen out before move 8 lets your opponent develop with tempo by attacking it.',
    good: pct(queenOut) <= 20,
  });
  rows.push({
    key: 'develop',
    label: 'Pieces developed by move 10',
    value: `${avgDev} of 4`,
    detail: 'Knights and bishops off the back rank. Three or more by move 10 is healthy.',
    good: avgDev >= 3,
  });
  rows.push({
    key: 'center',
    label: 'Central pawn in first 6 moves',
    value: `${100 - pct(noCenter)}% of games`,
    detail: 'A pawn on d4/e4 (or d5/e5) claims space and opens lines for your pieces.',
    good: pct(noCenter) <= 25,
  });
  rows.push({
    key: 'shuffle',
    label: 'Same piece moved 3+ times early',
    value: `${pct(shuffled)}% of games`,
    detail: 'Moving one piece repeatedly in the opening costs you development time.',
    good: pct(shuffled) <= 25,
  });
  return rows;
}

/**
 * Per-opening summary: your record, and how early things go wrong.
 * `analyses` supplies the engine view, so openings you have not analysed still
 * appear with a record but no mistake data.
 */
export function openingReport(games, analyses, minGames = 3) {
  const byFamily = new Map();
  for (const g of games) {
    const family = g.opening.split(' ').slice(0, 2).join(' ');
    const e = byFamily.get(family) || {
      family, games: 0, W: 0, L: 0, D: 0, exitPlies: [], firstMistakePlies: [], analysed: 0,
    };
    e.games++;
    e[g.resultForMe]++;

    const a = analyses.get(g.uuid);
    if (a) {
      e.analysed++;
      const first = a.records.find((r) => r.mover === g.myColor && r.severity && r.severity !== 'inaccuracy');
      if (first) e.firstMistakePlies.push(first.i);
    }
    byFamily.set(family, e);
  }
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return [...byFamily.values()]
    .filter((e) => e.games >= minGames)
    .map((e) => ({
      ...e,
      score: e.games ? (e.W + e.D / 2) / e.games : 0,
      avgFirstMistake: avg(e.firstMistakePlies),
    }))
    .sort((a, b) => b.games - a.games);
}
