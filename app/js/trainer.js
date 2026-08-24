// Puzzle trainer built from your own blunders.
//
// Reading "best was Be6" teaches very little. Being shown the position again,
// cold, and having to find the move yourself is what actually sticks. Positions
// you get wrong come back sooner, and a position is only retired once you have
// found it correctly twice in a row.

import { idbGet, idbPut } from './db.js';

const BOX_DELAYS = [0, 1, 3, 7, 21]; // days until a card is due, per box

export function puzzleId(gameUuid, moveIndex) {
  return `${gameUuid}:${moveIndex}`;
}

export async function getProgress() {
  return (await idbGet('kv', 'trainer')) || { cards: {} };
}

export async function saveProgress(p) {
  await idbPut('kv', 'trainer', p);
}

const DAY = 86400000;

function isDue(card, now) {
  if (!card) return true;
  return now >= card.due;
}

/**
 * Build the review queue: every blunder/mistake you made that has a known best
 * move, hardest first, with cards that aren't due yet filtered out.
 */
export function buildQueue(games, analyses, progress, { now = 0, includeInaccuracies = false } = {}) {
  const queue = [];
  for (const g of games) {
    const a = analyses.get(g.uuid);
    if (!a) continue;
    for (let i = 0; i < a.records.length; i++) {
      const r = a.records[i];
      if (r.mover !== g.myColor || !r.severity) continue;
      if (!includeInaccuracies && r.severity === 'inaccuracy') continue;
      if (!r.bestUci) continue;
      const id = puzzleId(g.uuid, r.i);
      const card = progress.cards[id];
      if (card && card.retired) continue;
      if (!isDue(card, now)) continue;
      queue.push({
        id,
        gameUuid: g.uuid,
        oppName: g.oppName,
        opening: g.opening,
        myColor: g.myColor,
        record: r,
        next: a.records[i + 1] || null,
        box: card ? card.box : 0,
        seen: card ? card.seen : 0,
      });
    }
  }
  // Unseen first, then by how much the mistake cost.
  queue.sort((x, y) => (x.seen - y.seen) || (y.record.drop - x.record.drop));
  return queue;
}

export function gradeCard(progress, id, correct, now = 0) {
  const card = progress.cards[id] || { box: 0, seen: 0, streak: 0, retired: false };
  card.seen++;
  if (correct) {
    card.streak++;
    card.box = Math.min(BOX_DELAYS.length - 1, card.box + 1);
    // two clean finds in a row and you clearly know it
    if (card.streak >= 2 && card.box >= BOX_DELAYS.length - 1) card.retired = true;
  } else {
    card.streak = 0;
    card.box = 0;
  }
  card.due = now + BOX_DELAYS[card.box] * DAY;
  progress.cards[id] = card;
  return card;
}

export function stats(games, analyses, progress) {
  let total = 0, attempted = 0, retired = 0;
  for (const g of games) {
    const a = analyses.get(g.uuid);
    if (!a) continue;
    for (const r of a.records) {
      if (r.mover !== g.myColor || !r.severity || r.severity === 'inaccuracy') continue;
      if (!r.bestUci) continue;
      total++;
      const card = progress.cards[puzzleId(g.uuid, r.i)];
      if (card) attempted++;
      if (card && card.retired) retired++;
    }
  }
  return { total, attempted, retired };
}
