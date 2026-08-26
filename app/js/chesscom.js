// Chess.com public API client with month-level caching in IndexedDB.
// The pub API needs no key and sends Access-Control-Allow-Origin: *.

import { idbGet, idbPut, idbGetAll } from './db.js';

const API = 'https://api.chess.com/pub';

const DRAW_CODES = new Set([
  'agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chess.com rate-limits bursts of archive requests. Retry those, and transient
// server errors, instead of aborting a whole sync on one unlucky call.
async function fetchJson(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(500 * attempt);
      continue;
    }
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= tries) {
      throw new Error(`Chess.com returned ${res.status} for ${url}`);
    }
    const after = parseInt(res.headers.get('retry-after') || '', 10);
    await sleep(Number.isFinite(after) ? after * 1000 : 500 * attempt);
  }
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
    const isCurrent = key === currentKey;
    const cached = await idbGet('months', `${user}|${key}`);
    // A month cached while it was still in progress is a partial snapshot. It
    // must be refetched once the month is over, or every game played after that
    // last sync stays missing forever. `complete` marks the ones safe to trust.
    let month = !isCurrent && cached && cached.complete ? cached : null;
    if (!month) {
      month = await fetchJson(url);
      // Still cached while current, so the offline fallback has this month too.
      await idbPut('months', `${user}|${key}`, { ...month, complete: !isCurrent });
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
