// Chess.com public API client with month-level caching in IndexedDB.
// The pub API needs no key and sends Access-Control-Allow-Origin: *.

import { idbGet, idbPut, idbGetAll } from './db.js';

const API = 'https://api.chess.com/pub';

const DRAW_CODES = new Set([
  'agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient',
]);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Chess.com returned ${res.status} for ${url}`);
  return res.json();
}

export function getProfile(user) {
  return fetchJson(`${API}/player/${encodeURIComponent(user)}`);
}

export function getStats(user) {
  return fetchJson(`${API}/player/${encodeURIComponent(user)}/stats`);
}

// Fetch every game the account has played. Past months are cached forever
// (they can't change); the current month is refetched on every sync.
export async function syncGames(user, onProgress) {
  const { archives } = await fetchJson(`${API}/player/${encodeURIComponent(user)}/games/archives`);
  const now = new Date();
  const currentKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const games = [];

  for (let i = 0; i < archives.length; i++) {
    const url = archives[i];
    const key = url.slice(-7); // "YYYY/MM"
    let month = key === currentKey ? null : await idbGet('months', `${user}|${key}`);
    if (!month) {
      month = await fetchJson(url);
      await idbPut('months', `${user}|${key}`, month);
    }
    games.push(...(month.games || []));
    if (onProgress) onProgress(i + 1, archives.length);
  }

  games.sort((a, b) => b.end_time - a.end_time);
  return games.map((g) => normalizeGame(g, user));
}

// Offline fallback: rebuild the game list from whatever months are cached.
export async function loadCachedGames(user) {
  const games = [];
  for (const [key, month] of await idbGetAll('months')) {
    if (typeof key === 'string' && key.startsWith(`${user}|`)) {
      games.push(...(month.games || []));
    }
  }
  games.sort((a, b) => b.end_time - a.end_time);
  return games.map((g) => normalizeGame(g, user));
}

function pgnHeader(pgn, name) {
  const m = pgn && pgn.match(new RegExp(`\\[${name} "([^"]*)"`));
  return m ? m[1] : null;
}

// "Scotch-Game-Classical-Variation-4...Bc5" -> "Scotch Game Classical Variation"
function prettyOpening(ecoUrl, pgn) {
  if (ecoUrl) {
    const slug = decodeURIComponent(ecoUrl.split('/openings/')[1] || '');
    if (slug) {
      const words = [];
      for (const tok of slug.split('-')) {
        if (/\d/.test(tok)) break; // stop at move-list tokens like "4...Bc5"
        words.push(tok);
      }
      if (words.length) return words.join(' ');
    }
  }
  return pgnHeader(pgn, 'ECO') || 'Unknown opening';
}

export function normalizeGame(g, user) {
  const lower = user.toLowerCase();
  const iAmWhite = g.white.username.toLowerCase() === lower;
  const me = iAmWhite ? g.white : g.black;
  const opp = iAmWhite ? g.black : g.white;
  const resultForMe = me.result === 'win' ? 'W' : DRAW_CODES.has(me.result) ? 'D' : 'L';
  const ecoUrl = pgnHeader(g.pgn, 'ECOUrl');
  return {
    uuid: g.uuid || g.url,
    url: g.url,
    pgn: g.pgn,
    endTime: g.end_time,
    timeClass: g.time_class,
    rated: g.rated,
    rules: g.rules, // "chess" for standard; chess960 etc. are listed but not analyzable
    myColor: iAmWhite ? 'w' : 'b',
    myRating: me.rating,
    myResultCode: me.result,
    oppName: opp.username,
    oppRating: opp.rating,
    resultForMe,
    opening: prettyOpening(ecoUrl, g.pgn),
  };
}
