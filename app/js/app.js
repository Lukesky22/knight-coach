// Knight Coach — app shell, views, replay, and coach UI.

import { idbGet, idbPut, idbGetAll } from './db.js';
import { getProfile, syncGames, loadCachedGames } from './chesscom.js';
import { Board } from './board.js';
import {
  analyzeGame, parseGame, fmtEval, isMateScore, explainMistake, dropDescription,
  classify, severity, positionNotes, describeBestMove, evalWhite,
  VERDICT_LABEL, getEngine, MATE_CP, THRESHOLD,
} from './analysis.js';
import { buildQueue, gradeCard, getProgress, saveProgress, stats } from './trainer.js';
import { loadBook, bookAt, bookExit, pickBookMove, habitReport, openingReport } from './openings.js';
import {
  hasApiKey, getApiKey, setApiKey, clearApiKey,
  explainMove, cachedExplanation, getSpend, spendUsd,
} from './explain.js';
import { LEVELS, engineMove, releaseEngine, buildPgn, outcomeOf } from './play.js';
import { Chess } from '../vendor/chess.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
// Coaching text marks the key move with **asterisks**; escape first, then let
// only that one pattern through as markup.
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

const S = {
  user: localStorage.getItem('kc.user') || '',
  depth: parseInt(localStorage.getItem('kc.depth') || '14', 10),
  games: [],
  analyses: new Map(), // uuid -> analysis result
  bulk: null,          // AbortController while "analyze all" runs
  offline: false,
  progress: null,      // trainer spaced-repetition state
  practice: [],        // games played in the app, kept alongside Chess.com ones
  playLevel: 2,
  playColor: 'w',
};

const SEV_LABEL = { blunder: 'Blunder', mistake: 'Mistake', inaccuracy: 'Inaccuracy' };
const SEV_ORDER = ['blunder', 'mistake', 'inaccuracy'];

// ---------------------------------------------------------------- boot

async function boot() {
  window.addEventListener('hashchange', route);
  if (!S.user) { renderSetup(); return; }
  await loadAccount();
  route();
}

async function loadAccount() {
  const view = $('#view');
  view.innerHTML = `<div class="center-note">Loading your games…</div>`;
  for (const [uuid, a] of await idbGetAll('analyses')) S.analyses.set(uuid, a);
  S.progress = await getProgress();
  S.practice = (await idbGet('kv', 'practiceGames')) || [];
  const before = S.games.length ? S.games.length : null;
  S.syncError = null;
  try {
    S.games = await syncGames(S.user, (i, n) => {
      view.innerHTML = `<div class="center-note">Fetching archives ${i}/${n}…</div>`;
    });
    // practice games sit in the same list, newest first
    S.games = [...S.practice, ...S.games].sort((a, b) => b.endTime - a.endTime);
    S.offline = false;
    S.lastSync = Date.now();
    S.newGames = before === null ? 0 : Math.max(0, S.games.length - before);
    localStorage.setItem('kc.lastSync', String(S.lastSync));
  } catch (err) {
    console.error(err);
    S.games = await loadCachedGames(S.user);
    S.offline = true;
    S.syncError = err.message;
  }
}

function agoText(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

function syncTabBar() {
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  // hidden during setup and while reviewing a game, where the screen is
  // already full and the back arrow is the natural way out
  const inGame = location.hash.startsWith('#g/') || location.hash === '#drill';
  bar.hidden = !S.user || inGame;
  for (const a of bar.querySelectorAll('a')) {
    a.classList.toggle('on', a.dataset.tab === (location.hash || ''));
  }
}

function route() {
  syncTabBar();
  if (!S.user) { renderSetup(); return; }
  const m = location.hash.match(/^#g\/(.+)$/);
  if (m) renderGame(decodeURIComponent(m[1]));
  else if (location.hash === '#train') renderTrain();
  else if (location.hash === '#openings') renderOpenings();
  else if (location.hash === '#drill') renderDrill();
  else if (location.hash === '#settings') renderSettings();
  else if (location.hash === '#play') renderPlay();
  else renderHome();
}

// ---------------------------------------------------------------- setup

function renderSetup() {
  $('#view').innerHTML = `
    <div class="setup">
      <div class="logo">♞</div>
      <h1>Knight Coach</h1>
      <p>Your games, reviewed by Stockfish, on your phone. Free.</p>
      <input id="user-in" placeholder="Chess.com username" autocapitalize="none" autocorrect="off" />
      <button id="user-go" class="btn primary">Load my games</button>
      <div id="setup-err" class="err"></div>
    </div>`;
  const go = async () => {
    const u = $('#user-in').value.trim();
    if (!u) return;
    $('#user-go').disabled = true;
    $('#setup-err').textContent = '';
    try {
      const p = await getProfile(u);
      S.user = p.username;
      localStorage.setItem('kc.user', p.username);
      await loadAccount();
      route();
    } catch {
      $('#setup-err').textContent = `Couldn't find "${esc(u)}" on Chess.com.`;
      $('#user-go').disabled = false;
    }
  };
  $('#user-go').onclick = go;
  $('#user-in').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

// ---------------------------------------------------------------- home

function record(games) {
  const r = { W: 0, L: 0, D: 0 };
  for (const g of games) r[g.resultForMe]++;
  return r;
}

function sparkline(values, w = 320, h = 48) {
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((v - min) / span) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts.join(' ')}" />
  </svg>
  <div class="spark-caption">${min} → ${values[values.length - 1]} rating</div>`;
}

function coachNotes() {
  const analyzed = S.games.filter((g) => S.analyses.has(g.uuid));
  if (analyzed.length < 3) return '';
  const phase = { opening: 0, middlegame: 0, endgame: 0 };
  const perOpening = new Map();
  let flaggedTotal = 0, acplSum = 0;
  let serious = 0, punishedAtOnce = 0;
  const acplByGame = [];
  for (const g of analyzed) {
    const a = S.analyses.get(g.uuid);
    acplSum += a.summary.acpl;
    acplByGame.push({ t: g.endTime, acpl: a.summary.acpl });
    const bad = a.records.filter((r) => r.mover === g.myColor && r.severity);
    flaggedTotal += bad.length;
    for (const r of bad) phase[r.phase]++;
    // How often does the very next move punish the mistake? A capture or check
    // straight back means it was a hanging piece, not a subtle positional slip.
    for (let i = 0; i < a.records.length; i++) {
      const r = a.records[i];
      if (r.mover !== g.myColor || !r.severity || r.severity === 'inaccuracy') continue;
      serious++;
      const reply = a.records[i + 1];
      if (reply && /x|\+|#/.test(reply.san)) punishedAtOnce++;
    }
    // Group by opening family ("Sicilian Defense Chekhover Variation" ->
    // "Sicilian Defense") so each bucket has enough games to mean something.
    const family = g.opening.split(' ').slice(0, 2).join(' ');
    const o = perOpening.get(family) || { games: 0, bad: 0 };
    o.games++; o.bad += bad.filter((r) => r.severity !== 'inaccuracy').length;
    perOpening.set(family, o);
  }
  const notes = [];
  const avg = Math.round(acplSum / analyzed.length);
  notes.push(`Average centipawn loss over ${analyzed.length} analyzed games: <b>${avg}</b> (lower is better; ~50 is club level).`);
  if (flaggedTotal) {
    const worstPhase = Object.entries(phase).sort((a, b) => b[1] - a[1])[0];
    notes.push(`Most of your mistakes come in the <b>${worstPhase[0]}</b> (${Math.round((worstPhase[1] / flaggedTotal) * 100)}% of ${flaggedTotal} flagged moves).`);
  }
  if (serious) {
    const pct = Math.round((punishedAtOnce / serious) * 100);
    notes.push(`<b>${pct}% of your serious mistakes are punished by your opponent's very next move</b> — a capture or a check. These are hanging pieces, not deep positional errors.`);
  }
  // Only call an opening a leak if it is meaningfully worse than your own
  // baseline; your most-played opening will otherwise always "win".
  const avgBad = serious / analyzed.length;
  const leaky = [...perOpening.entries()]
    .filter(([, o]) => o.games >= 5 && o.bad / o.games > avgBad * 1.25)
    .sort((a, b) => b[1].bad / b[1].games - a[1].bad / a[1].games)[0];
  if (leaky) {
    const per = (leaky[1].bad / leaky[1].games).toFixed(1);
    notes.push(`<b>${esc(leaky[0])}</b> goes worse than your average: ${per} serious mistakes per game over ${leaky[1].games} games, against ${avgBad.toFixed(1)} normally.`);
  }
  if (acplByGame.length >= 6) {
    acplByGame.sort((a, b) => a.t - b.t);
    const half = Math.floor(acplByGame.length / 2);
    const early = Math.round(acplByGame.slice(0, half).reduce((s, x) => s + x.acpl, 0) / half);
    const late = Math.round(acplByGame.slice(half).reduce((s, x) => s + x.acpl, 0) / (acplByGame.length - half));
    if (late < early - 5) notes.push(`You're improving: ACPL fell from ${early} (older games) to ${late} (recent).`);
    else if (late > early + 5) notes.push(`Recent games are sloppier: ACPL rose from ${early} to ${late}. Slow down.`);
  }
  return `<div class="card"><h2>Coach's notes</h2><ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul></div>`;
}

function trainCard() {
  if (!S.progress) return '';
  const s = stats(S.games, S.analyses, S.progress);
  if (!s.total) return '';
  const due = buildQueue(S.games, S.analyses, S.progress, { now: Date.now() }).length;
  const pct = s.total ? Math.round((s.retired / s.total) * 100) : 0;
  return `
    <div class="card train-card">
      <div class="row-between">
        <h2>Training</h2>
        <span class="sub">${s.retired}/${s.total} mastered</span>
      </div>
      <p class="sub">Your own blunders, served back as puzzles. Find the move you missed.</p>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <a class="btn primary block" href="#train">
        ${due ? `Train ${due} position${due === 1 ? '' : 's'}` : 'Nothing due — practise anyway'}
      </a>
    </div>`;
}

function renderHome() {
  const g = S.games;
  const rec = record(g);
  const white = record(g.filter((x) => x.myColor === 'w'));
  const black = record(g.filter((x) => x.myColor === 'b'));
  const chrono = [...g].sort((a, b) => a.endTime - b.endTime);
  const ratings = chrono.filter((x) => x.rated).map((x) => x.myRating);
  const analyzedCount = g.filter((x) => S.analyses.has(x.uuid)).length;

  const openings = new Map();
  for (const x of g) {
    const o = openings.get(x.opening) || { n: 0, W: 0, L: 0, D: 0 };
    o.n++; o[x.resultForMe]++;
    openings.set(x.opening, o);
  }
  const topOpenings = [...openings.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5);

  $('#view').innerHTML = `
    <header class="top">
      <div>
        <h1>♞ Knight Coach</h1>
        <div class="sub" id="sync-state">${esc(S.user)} · ${g.length} games · ${
          S.offline
            ? `offline, showing cached data`
            : `synced ${agoText(S.lastSync)}${S.newGames ? ` · ${S.newGames} new` : ''}`
        }</div>
      </div>
      <button id="sync" class="btn small">Sync</button>
    </header>

    <div class="card">
      <div class="rec-row">
        <div class="rec"><b>${rec.W}</b><span>wins</span></div>
        <div class="rec"><b>${rec.L}</b><span>losses</span></div>
        <div class="rec"><b>${rec.D}</b><span>draws</span></div>
      </div>
      <div class="color-rec">As White: ${white.W}-${white.L}-${white.D} · As Black: ${black.W}-${black.L}-${black.D}</div>
      ${sparkline(ratings)}
    </div>

    <div class="card">
      <div class="row-between">
        <h2>Analysis</h2>
        <span class="sub">${analyzedCount}/${g.length} games</span>
      </div>
      <div class="row">
        <label class="sub">Depth
          <select id="depth">${[10, 12, 14, 16, 18].map((d) =>
            `<option ${d === S.depth ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </label>
        <button id="bulk" class="btn small">${S.bulk ? 'Stop' : 'Analyze all'}</button>
      </div>
      <div id="bulk-status" class="sub"></div>
      <div class="progress" id="bulk-bar-wrap" ${S.bulk ? '' : 'hidden'}><div id="bulk-bar"></div></div>
    </div>

    ${trainCard()}

    <div class="card">
      <h2>Openings</h2>
      <p class="sub">Your habits, where you leave theory, and a drill for each opening you play.</p>
      <a class="btn primary block" href="#openings">Coach my openings</a>
    </div>

    ${coachNotes()}

    ${topOpenings.length ? `<div class="card"><h2>Your openings</h2>
      ${topOpenings.map(([name, o]) => `
        <div class="opening-row">
          <div class="opening-name">${esc(name)}</div>
          <div class="opening-stat">${o.W}-${o.L}-${o.D}</div>
          <div class="wlbar"><i style="width:${(o.W / o.n) * 100}%"></i><u style="width:${(o.D / o.n) * 100}%"></u></div>
        </div>`).join('')}
    </div>` : ''}

    <div class="card">
      <h2>Games</h2>
      <div class="games">
        ${g.map((x) => {
          const a = S.analyses.get(x.uuid);
          const badge = a
            ? `<span class="badge done">d${a.depth} · ${a.summary.counts.blunder}B ${a.summary.counts.mistake}M</span>`
            : (x.rules === 'chess' ? '' : `<span class="badge">variant</span>`);
          return `
          <a class="game res-${x.resultForMe}" href="#g/${encodeURIComponent(x.uuid)}">
            <span class="res">${x.resultForMe}</span>
            <span class="dot ${x.myColor === 'w' ? 'wdot' : 'bdot'}"></span>
            <span class="opp">${esc(x.oppName)}${x.oppRating ? ` <i>(${x.oppRating})</i>` : ''}</span>
            <span class="meta">${esc(x.opening)}</span>
            <span class="when">${new Date(x.endTime * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${badge}</span>
          </a>`;
        }).join('')}
      </div>
    </div>

    <div class="foot">
      <a href="#settings">Settings</a> · <a href="#" id="switch">Switch account</a>
    </div>`;

  $('#sync').onclick = async () => {
    const btn = $('#sync');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    await loadAccount();
    renderHome();
    const state = $('#sync-state');
    if (state) {
      state.textContent = S.offline
        ? `Sync failed: ${S.syncError || 'no connection'} — showing cached data`
        : `${S.user} · ${S.games.length} games · ${S.newGames ? `${S.newGames} new game${S.newGames === 1 ? '' : 's'}` : 'already up to date'}`;
    }
  };
  $('#switch').onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('kc.user');
    S.user = ''; S.games = [];
    renderSetup();
  };
  $('#depth').onchange = (e) => {
    S.depth = parseInt(e.target.value, 10);
    localStorage.setItem('kc.depth', String(S.depth));
  };
  $('#bulk').onclick = () => (S.bulk ? S.bulk.abort() : analyzeAll());
}

async function analyzeAll() {
  const todo = S.games.filter((g) => g.rules === 'chess' && !S.analyses.has(g.uuid));
  if (!todo.length) return;
  S.bulk = new AbortController();
  // Re-query the progress elements on every update: the user may navigate to a
  // game view and back mid-run, which replaces this DOM.
  const btn = $('#bulk');
  if (btn) btn.textContent = 'Stop';
  const wrap = $('#bulk-bar-wrap');
  if (wrap) wrap.hidden = false;
  try {
    for (let i = 0; i < todo.length; i++) {
      const g = todo[i];
      const status = $('#bulk-status');
      if (status) status.textContent = `Game ${i + 1}/${todo.length}: vs ${g.oppName}`;
      const a = await analyzeGame({
        pgn: g.pgn, myColor: g.myColor, depth: S.depth, signal: S.bulk.signal,
        onProgress: (p, n) => {
          const bar = $('#bulk-bar');
          if (bar) bar.style.width = `${((i + p / n) / todo.length) * 100}%`;
        },
      });
      await idbPut('analyses', g.uuid, a);
      S.analyses.set(g.uuid, a);
    }
  } catch (err) {
    if (!err.cancelled) console.error(err);
  }
  S.bulk = null;
  if (location.hash === '' || location.hash === '#') renderHome();
}

// ---------------------------------------------------------------- game view

function renderGame(uuid) {
  const g = S.games.find((x) => x.uuid === uuid);
  if (!g) { location.hash = ''; return; }

  let parsed;
  try {
    parsed = parseGame(g.pgn);
  } catch (err) {
    $('#view').innerHTML = `<div class="center-note">Couldn't parse this game (${esc(err.message)}). <a href="#">Back</a></div>`;
    return;
  }
  const { moves, startFen } = parsed;
  let analysis = S.analyses.get(uuid) || null;
  let idx = 0; // 0 = starting position, i = after move i
  let ctrl = null; // AbortController for single-game analysis
  let explore = null; // set while you are trying your own moves on the board

  const resultText = { W: 'You won', L: 'You lost', D: 'Draw' }[g.resultForMe];

  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#">←</a>
      <div>
        <h1>vs ${esc(g.oppName)}${g.oppRating ? ` (${g.oppRating})` : ''}</h1>
        <div class="sub">${resultText} · ${esc(g.myResultCode)} · ${esc(g.opening)}</div>
      </div>
      <a class="btn small" href="${esc(g.url)}" target="_blank" rel="noopener">↗</a>
    </header>

    <div id="strip-top" class="player-strip"></div>
    <div class="board-wrap">
      <div class="evalbar"><div id="evalfill"></div></div>
      <div id="board"></div>
    </div>
    <div id="strip-bottom" class="player-strip"></div>
    <div id="turn-hint" class="note warn" hidden></div>

    <div class="controls">
      <button class="btn nav" id="nav-start">⏮</button>
      <button class="btn nav" id="nav-prev">◀</button>
      <div class="eval-read" id="eval-read">—</div>
      <button class="btn nav" id="nav-next">▶</button>
      <button class="btn nav" id="nav-end">⏭</button>
    </div>

    <div class="jumprow" id="jumprow"></div>
    <div id="review"></div>
    <div id="graph-wrap"></div>
    <div class="card"><div class="movegrid" id="movegrid"></div></div>
    <div id="analyze-area"></div>
    <div id="coach"></div>`;

  const board = new Board($('#board'));
  board.setFlip(g.myColor === 'b');

  const fenAt = (i) => (i === 0 ? startFen : moves[i - 1].after);
  const recAt = (i) => (analysis && i > 0 ? analysis.records[i - 1] : null);
  let playingLine = false; // true while the better line is being demonstrated

  function goTo(newIdx) {
    if (playingLine) return;
    explore = null; // stepping through the game leaves any side line
    idx = Math.max(0, Math.min(moves.length, newIdx));
    drawCurrent();
    for (const el of document.querySelectorAll('.mv')) el.classList.remove('cur');
    if (idx > 0) $(`.mv[data-i="${idx}"]`)?.classList.add('cur');
    updateEvalUI();
    renderReview();
    renderJumpRow();
  }

  // Stepping one ply at a time to find your own errors is a chore; these skip
  // straight to them.
  function myMistakeIndexes() {
    if (!analysis) return [];
    return analysis.records
      .filter((r) => r.mover === g.myColor && r.severity && r.severity !== 'inaccuracy')
      .map((r) => r.i);
  }

  function renderJumpRow() {
    const row = $('#jumprow');
    if (!row) return;
    const spots = myMistakeIndexes();
    if (!spots.length) { row.innerHTML = ''; return; }
    const prev = [...spots].reverse().find((i) => i < idx);
    const next = spots.find((i) => i > idx);
    const pos = spots.indexOf(idx);
    row.innerHTML = `
      <button class="btn small" id="jump-prev" ${prev === undefined ? 'disabled' : ''}>‹ mistake</button>
      <span class="sub">${pos >= 0 ? `your mistake ${pos + 1} of ${spots.length}` : `${spots.length} of your mistakes`}</span>
      <button class="btn small" id="jump-next" ${next === undefined ? 'disabled' : ''}>mistake ›</button>`;
    const p = $('#jump-prev'), n = $('#jump-next');
    if (p && prev !== undefined) p.onclick = () => goTo(prev);
    if (n && next !== undefined) n.onclick = () => goTo(next);
  }

  const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };

  // Which pieces each side has captured, and who is up on material.
  function capturedAt(fen) {
    const board = fen.split(' ')[0];
    const left = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const ch of board) {
      const lower = ch.toLowerCase();
      if (!(lower in PIECE_VALUE)) continue;
      left[ch === ch.toUpperCase() ? 'w' : 'b'][lower]++;
    }
    const out = { w: [], b: [], score: 0 };
    for (const type of ['q', 'r', 'b', 'n', 'p']) {
      for (const side of ['w', 'b']) {
        const gone = START_COUNT[type] - left[side][type];
        for (let i = 0; i < gone; i++) {
          // a white piece missing is a capture *by* Black
          out[side === 'w' ? 'b' : 'w'].push(`${side}${type.toUpperCase()}`);
        }
        out.score += (side === 'w' ? -1 : 1) * gone * PIECE_VALUE[type];
      }
    }
    return out; // score > 0 means White is up
  }

  function renderStrips() {
    const cap = capturedAt(fenAt(idx));
    const meTop = g.myColor === 'b'; // board is flipped when you are Black
    const rows = [
      { side: meTop ? 'w' : 'b', el: $('#strip-top') },
      { side: meTop ? 'b' : 'w', el: $('#strip-bottom') },
    ];
    for (const { side, el } of rows) {
      if (!el) continue;
      const isMe = side === g.myColor;
      const name = isMe ? S.user : g.oppName;
      const rating = isMe ? g.myRating : g.oppRating;
      const lead = side === 'w' ? cap.score : -cap.score;
      el.innerHTML = `
        <span class="dot ${side === 'w' ? 'wdot' : 'bdot'}"></span>
        <span class="pname">${esc(name)}</span>
        <span class="prating">${rating}</span>
        <span class="captured">${cap[side].map((c) =>
          `<img src="pieces/${c}.svg" alt="">`).join('')}</span>
        ${lead > 0 ? `<span class="lead">+${lead}</span>` : ''}`;
    }
  }

  // The engine's choice FROM the position you are looking at. records[i] is the
  // move played from position i, so its PV is what was best standing here.
  function bestUciAt(i) {
    return analysis && analysis.records[i] ? analysis.records[i].bestUci : null;
  }

  const exploreLegal = (sq) => {
    const c = explore ? explore.chess : new Chess(fenAt(idx));
    const dests = c.moves({ square: sq, verbose: true }).map((m) => m.to);
    if (!dests.length) {
      // Tapping a piece that cannot move is the single most confusing moment on
      // an analysis board, so say why instead of doing nothing.
      const piece = c.get(sq);
      if (piece && piece.color !== c.turn()) {
        const side = c.turn() === 'w' ? 'White' : 'Black';
        const hint = `It is ${side} to move in this position. Use “Play it differently” to go back a move and play your own.`;
        if (explore) { explore.hint = hint; renderReview(); }
        else { showTurnHint(hint); }
      }
    }
    return dests;
  };

  function showTurnHint(text) {
    const el = $('#turn-hint');
    if (el) {
      el.textContent = text;
      el.hidden = false;
      clearTimeout(showTurnHint.t);
      showTurnHint.t = setTimeout(() => { el.hidden = true; }, 4000);
    }
  }

  // Every position shows the best move in green, and the board always accepts
  // a move so you can try your own ideas from anywhere in the game.
  function drawCurrent() {
    if (explore) { drawExplore(); return; }
    const arrows = [];
    const best = bestUciAt(idx);
    if (best) {
      arrows.push({ from: best.slice(0, 2), to: best.slice(2, 4), kind: 'best' });
    }
    board.position(fenAt(idx), {
      lastMove: idx > 0 ? [moves[idx - 1].from, moves[idx - 1].to] : null,
      arrows,
    });
    board.setInteractive(true, { legalFrom: exploreLegal, onMove: startExplore });
    renderStrips();
  }

  function drawExplore() {
    const h = explore.chess.history({ verbose: true });
    const last = h[h.length - 1];
    board.position(explore.chess.fen(), {
      lastMove: last ? [last.from, last.to] : null,
      arrows: explore.bestReply
        ? [{ from: explore.bestReply.slice(0, 2), to: explore.bestReply.slice(2, 4), kind: 'best' }]
        : [],
    });
    board.setInteractive(true, { legalFrom: exploreLegal, onMove: playInExplore });
    renderStrips();
  }

  // Start a side line from `startIdx`. Landing on one of your own moves rewinds
  // a ply first, because "let me try that again" means playing your move over,
  // and after it has been played the board is showing your opponent's turn.
  function beginExplore(startIdx) {
    explore = {
      chess: new Chess(fenAt(startIdx)),
      from: startIdx,
      sans: [],
      bestReply: null,
      evalCp: null,
      thinking: false,
      hint: '',
    };
    drawExplore();
    renderReview();
  }

  function startExplore({ from, to }) {
    if (!explore) beginExplore(idx);
    playInExplore({ from, to });
  }

  async function playInExplore({ from, to }) {
    if (explore.thinking) return;
    let mv;
    try { mv = explore.chess.move({ from, to, promotion: 'q' }); } catch { return; }
    if (!mv) return;
    explore.sans.push(mv.san);
    explore.bestReply = null;
    explore.hint = '';
    drawExplore();
    renderReview();
    await engineReply();
    scoreExplore();
  }

  // The other side answers, so a side line plays like a real game rather than
  // stopping dead after one move.
  async function engineReply() {
    if (ctrl || explore.autoReplyOff) return;
    const over = explore.chess.isGameOver();
    if (over) return;
    const mine = explore;
    mine.thinking = true;
    drawExplore();
    renderReview();
    try {
      const eng = await getEngine();
      const info = await eng.evalPosition(mine.chess.fen(), 12);
      if (explore !== mine) return;
      const uci = info.pv && info.pv.length ? info.pv[0] : null;
      if (uci) {
        const mv = mine.chess.move({
          from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q',
        });
        if (mv) mine.sans.push(mv.san);
      }
    } catch { /* leave the line where it is */ }
    mine.thinking = false;
    drawExplore();
    renderReview();
  }

  function takeBackExplore() {
    if (!explore || explore.thinking) return;
    // undo the pair, so it is your turn again
    if (explore.chess.history().length >= 2) {
      explore.chess.undo(); explore.chess.undo(); explore.sans.splice(-2);
    } else if (explore.chess.history().length === 1) {
      explore.chess.undo(); explore.sans.pop();
    }
    if (!explore.sans.length) { leaveExplore(); return; }
    explore.bestReply = null;
    explore.evalCp = null;
    drawExplore();
    renderReview();
    scoreExplore();
  }

  // Judge the position the exploration has reached, and show the reply the
  // engine would make. Requests queue behind a running review rather than being
  // dropped, so the panel still fills in while the game is being analysed.
  async function scoreExplore() {
    const mine = explore;
    try {
      const eng = await getEngine();
      // Same depth as the game analysis, so the comparison below is like for like.
      const info = await eng.evalPosition(mine.chess.fen(), (analysis && analysis.depth) || S.depth);
      if (explore !== mine) return; // moved on since
      const stm = mine.chess.turn();
      const cp = info.type === 'mate'
        ? (info.value > 0 ? MATE_CP - info.value : -(MATE_CP + info.value))
        : info.value;
      mine.evalCp = stm === 'w' ? cp : -cp; // White's viewpoint, like everything else
      mine.bestReply = info.pv && info.pv.length ? info.pv[0] : null;
      drawExplore();
      renderReview();
    } catch { /* leave the panel as it is */ }
  }

  function leaveExplore() {
    explore = null;
    drawCurrent();
    renderReview();
    updateEvalUI();
  }

  // Rewind one ply and walk through what the engine wanted, so the improvement
  // is something you watch happen rather than a line of notation.
  async function playBetterLine() {
    const rec = recAt(idx);
    if (!rec || !rec.bestUci || playingLine) return;
    playingLine = true;
    const btn = $('#show-line');
    if (btn) btn.disabled = true;

    const line = new Chess(rec.fenBefore);
    const uciLine = [rec.bestUci];
    // rebuild the rest of the engine's line from the SAN we stored
    const sanRest = rec.bestLine ? rec.bestLine.replace(/^\d+\.+\s*/, '').split(' ').filter((t) => !/^\d+\.+$/.test(t)) : [];

    board.position(rec.fenBefore, { lastMove: null, arrows: [
      { from: rec.bestUci.slice(0, 2), to: rec.bestUci.slice(2, 4), kind: 'best' },
    ] });
    await new Promise((r) => setTimeout(r, 700));

    for (const san of sanRest) {
      let mv;
      try { mv = line.move(san); } catch { break; }
      if (!mv) break;
      board.position(line.fen(), { lastMove: [mv.from, mv.to], arrows: [] });
      const panel = $('#line-status');
      if (panel) panel.textContent = `Better line: ${line.history().join(' ')}`;
      await new Promise((r) => setTimeout(r, 750));
    }
    await new Promise((r) => setTimeout(r, 600));
    playingLine = false;
    drawCurrent();
    renderReview();
  }

  function renderReview() {
    const panel = $('#review');
    if (!panel) return;
    if (!analysis) {
      panel.innerHTML = `
        <div class="card">
          <h2>Reviewing this game…</h2>
          <p class="sub" id="auto-status">Stockfish is looking at every position. This takes a few seconds.</p>
          <div class="progress"><div id="auto-bar"></div></div>
        </div>`;
      return;
    }
    if (explore) {
      const baseEval = analysis.evals[explore.from];
      const lost = explore.evalCp === null ? null
        : (g.myColor === 'w' ? baseEval - explore.evalCp : explore.evalCp - baseEval);
      const over = explore.chess.isGameOver();
      panel.innerHTML = `
        <div class="card review-card ${lost !== null && lost >= THRESHOLD ? 'mistake' : 'best'}">
          <div class="review-head">
            <div><span class="verdict">Your line</span></div>
            <span class="sub">${explore.thinking ? 'engine replying…' : 'playing it out'}</span>
          </div>
          <p class="review-move">${esc(explore.sans.join(' ')) || 'Your move — play anything.'}</p>
          ${explore.evalCp === null || explore.thinking
            ? `<p class="sub">${explore.thinking ? 'The engine is choosing its answer…' : 'Working out how good that is…'}</p>`
            : `<p class="why">Position is now <b>${esc(fmtEval(explore.evalCp))}</b>${
                lost !== null
                  ? lost >= THRESHOLD
                    ? ` — about ${(lost / 100).toFixed(1)} pawns worse for you than the game position.`
                    : lost <= -50
                      ? ` — ${(-lost / 100).toFixed(1)} pawns better for you than what happened in the game.`
                      : ' — much the same as the game position.'
                  : ''
              }</p>`}
          ${over ? `<p class="why">That ends the game right there.</p>` : ''}
          ${explore.hint ? `<div class="note warn">${esc(explore.hint)}</div>` : ''}
          <p class="sub">Keep playing moves — the engine answers each one. Green is its choice.</p>
          <div class="row">
            <button class="btn small" id="ex-undo" ${explore.sans.length ? '' : 'disabled'}>Take back</button>
            <button class="btn small" id="ex-back">← Back to the game</button>
          </div>
        </div>`;
      const back = $('#ex-back');
      if (back) back.onclick = leaveExplore;
      const undo = $('#ex-undo');
      if (undo) undo.onclick = takeBackExplore;
      return;
    }

    const rec = recAt(idx);
    if (!rec) {
      panel.innerHTML = `<div class="card">
        <h2>Starting position</h2>
        <p class="sub">The green arrow is the engine's move for whatever position you are
        looking at. Step through with ▶, or just move a piece on the board to try your own
        idea and see what it is worth.</p>
      </div>`;
      return;
    }

    const verdict = classify(rec);
    const isMine = rec.mover === g.myColor;
    const bad = ['inaccuracy', 'mistake', 'blunder', 'missed-win'].includes(verdict);
    const notes = positionNotes(fenAt(idx), g.myColor, Math.ceil(idx / 2));
    const nextRec = analysis.records[rec.i] || null;

    panel.innerHTML = `
      <div class="card review-card ${verdict}">
        <div class="review-head">
          <div>
            <span class="verdict ${verdict}">${VERDICT_LABEL[verdict]}</span>
            <b class="review-move">${esc(rec.label)} ${esc(rec.san)}</b>
          </div>
          <span class="sub">${isMine ? 'your move' : `${esc(g.oppName)}'s move`}</span>
        </div>

        ${bad && isMine ? `
          <p class="why">${rich(explainMistake(rec, nextRec))}</p>
          <div class="legend">
            <span><i class="sw played"></i>what you played</span>
            <span><i class="sw best"></i>what was better</span>
          </div>
          <div class="row">
            <button class="btn small" id="show-line">▶ Watch the better line</button>
            <button class="btn small primary" id="try-here">Play it differently</button>
            ${hasApiKey() ? `<button class="btn small" id="ask-coach">Ask the coach</button>` : ''}
          </div>
          <div class="sub" id="line-status"></div>
          <div id="coach-text"></div>
          ${hasApiKey() ? '' : `<div class="upsell">Want this explained properly — the plan,
            not just the tactic? <a href="#settings">Add a Claude key</a> and every mistake
            gets a written coaching note. About 2¢ a game.</div>`}
        ` : !isMine ? `
          <p class="sub">${bad
            ? `${esc(g.oppName)} slipped here, which is why the evaluation moved your way.`
            : `${esc(g.oppName)}'s move. Nothing for you to do about it.`}</p>
        ` : verdict === 'best' ? `
          <p class="why">You found the engine's first choice.</p>
        ` : `
          <p class="why">Fine — the evaluation barely moved.</p>
        `}

        ${notes.length ? `<div class="notes-block">
          <div class="sub">In this position:</div>
          ${notes.map((n) => `<div class="note ${n.kind}">${esc(n.text)}</div>`).join('')}
        </div>` : ''}
      </div>`;

    const showBtn = $('#show-line');
    if (showBtn) showBtn.onclick = playBetterLine;
    // rewind one ply so the position is the one you actually had to solve
    const tryBtn = $('#try-here');
    if (tryBtn) tryBtn.onclick = () => beginExplore(idx - 1);
    const askBtn = $('#ask-coach');
    if (askBtn) {
      askBtn.onclick = () => askCoach(rec, nextRec, askBtn);
      // if this move was explained before, show it straight away and for free
      cachedExplanation(rec).then((text) => {
        if (text && $('#coach-text')) {
          $('#coach-text').innerHTML = `<div class="coach-said">${esc(text)}</div>`;
          askBtn.remove();
        }
      });
    }
  }

  async function askCoach(rec, nextRec, btn) {
    const out = $('#coach-text');
    if (!out) return;
    btn.disabled = true;
    btn.textContent = 'Asking…';
    out.innerHTML = `<div class="sub">Claude is looking at the position…</div>`;
    try {
      const { text, cached, spend } = await explainMove({
        rec,
        mechanical: explainMistake(rec, nextRec),
        opening: g.opening,
        myColor: g.myColor,
        oppName: g.oppName,
      });
      out.innerHTML = `
        <div class="coach-said">${esc(text)}</div>
        <div class="sub coach-meta">${cached
          ? 'From cache, no charge.'
          : `Claude Sonnet 5 · $${spendUsd(spend).toFixed(3)} spent in total`}</div>`;
      btn.remove();
    } catch (err) {
      out.innerHTML = `<div class="note warn">${esc(err.message)}
        ${/key/i.test(err.message) ? ' <a href="#settings">Open settings</a>' : ''}</div>`;
      btn.disabled = false;
      btn.textContent = 'Ask the coach';
    }
  }

  // Put the position back in front of you and make you find the move.
  function updateEvalUI() {
    const read = $('#eval-read');
    const fill = $('#evalfill');
    if (analysis && analysis.evals[idx] !== undefined) {
      const v = analysis.evals[idx];
      read.textContent = fmtEval(v);
      const pct = isMateScore(v)
        ? (v > 0 ? 100 : 0)
        : 50 + 50 * (2 / (1 + Math.exp(-v / 400)) - 1);
      fill.style.height = `${pct}%`;
      const cursor = $('#graph-cursor');
      if (cursor) cursor.setAttribute('x', String((idx / Math.max(1, moves.length)) * 320));
    } else {
      read.textContent = idx === 0 ? 'start' : `move ${Math.ceil(idx / 2)}`;
      fill.style.height = '50%';
    }
  }

  function renderMoveGrid() {
    const grid = $('#movegrid');
    let html = '';
    for (let i = 0; i < moves.length; i += 2) {
      html += `<span class="num">${i / 2 + 1}.</span>`;
      for (const j of [i, i + 1]) {
        if (j >= moves.length) break;
        const r = analysis && analysis.records[j];
        const v = r ? classify(r) : null;
        // only mark your own moves: the point is to review your play
        const mark = r && r.mover === g.myColor && v && v !== 'good' && v !== 'excellent'
          ? `<i class="mdot ${v}"></i>` : '';
        html += `<span class="mv" data-i="${j + 1}">${esc(moves[j].san)}${mark}</span>`;
      }
    }
    grid.innerHTML = html || '<span class="sub">No moves were played.</span>';
    grid.onclick = (e) => {
      const mv = e.target.closest('.mv');
      if (mv) goTo(parseInt(mv.dataset.i, 10));
    };
  }

  function renderGraph() {
    const wrap = $('#graph-wrap');
    if (!analysis || analysis.evals.length < 2) { wrap.innerHTML = ''; return; }
    const w = 320, h = 60, n = analysis.evals.length;
    const pts = analysis.evals.map((v, i) => {
      const c = Math.max(-500, Math.min(500, isMateScore(v) ? Math.sign(v) * 500 : v));
      const x = (i / (n - 1)) * w;
      const y = h / 2 - (c / 500) * (h / 2 - 3);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    wrap.innerHTML = `
      <svg class="evalgraph" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <rect x="0" y="0" width="${w}" height="${h / 2}" class="gwhite"/>
        <rect x="0" y="${h / 2}" width="${w}" height="${h / 2}" class="gblack"/>
        <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" class="gmid"/>
        <polyline points="${pts.join(' ')}" class="gline"/>
        <rect id="graph-cursor" x="0" y="0" width="1.5" height="${h}" class="gcursor"/>
      </svg>`;
    const svg = wrap.firstElementChild;
    svg.addEventListener('click', (e) => {
      const box = svg.getBoundingClientRect();
      const frac = (e.clientX - box.left) / box.width;
      goTo(Math.round(frac * moves.length));
    });
  }

  function renderAnalyzeArea() {
    const area = $('#analyze-area');
    if (g.rules !== 'chess') {
      area.innerHTML = `<div class="card sub">Variant game (${esc(g.rules)}) — analysis works on standard chess only.</div>`;
      return;
    }
    if (!analysis) { area.innerHTML = ''; return; } // the review is running itself
    // Only offered once a review exists: a deeper second look is a deliberate
    // choice, not something to put in the way of reading the first one.
    area.innerHTML = `
      <div class="card">
        <div class="row">
          <span class="sub">Reviewed at depth ${analysis.depth}.</span>
          <label class="sub">Deeper
            <select id="g-depth">${[14, 16, 18, 20].map((d) =>
              `<option ${d === S.depth ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </label>
          <button id="g-analyze" class="btn small">Re-run</button>
        </div>
        <div class="progress" id="g-bar-wrap" hidden><div id="g-bar"></div></div>
      </div>`;
    $('#g-depth').onchange = (e) => {
      S.depth = parseInt(e.target.value, 10);
      localStorage.setItem('kc.depth', String(S.depth));
    };
    $('#g-analyze').onclick = () => {
      if (ctrl) { ctrl.abort(); return; }
      $('#g-bar-wrap').hidden = false;
      runReview(S.depth, (p, n) => {
        const bar = $('#g-bar');
        if (bar) bar.style.width = `${(p / n) * 100}%`;
      });
    };
  }

  /**
   * Run the engine over this game and refresh everything that depends on it.
   * Called automatically when a game has never been reviewed - waiting behind
   * a button was the single worst thing about the old flow.
   */
  async function runReview(depth, onProgress) {
    if (ctrl) return;
    ctrl = new AbortController();
    try {
      const a = await analyzeGame({
        pgn: g.pgn,
        myColor: g.myColor,
        depth,
        signal: ctrl.signal,
        onProgress: onProgress || ((p, n) => {
          const bar = $('#auto-bar');
          if (bar) bar.style.width = `${(p / n) * 100}%`;
          const st = $('#auto-status');
          if (st) st.textContent = `Looking at position ${p} of ${n}…`;
        }),
      });
      await idbPut('analyses', g.uuid, a);
      S.analyses.set(g.uuid, a);
      analysis = a;
      renderGraph(); renderMoveGrid(); renderCoach(); renderAnalyzeArea();
      goTo(idx);
    } catch (err) {
      if (!err.cancelled) {
        console.error(err);
        const panel = $('#review');
        if (panel) {
          panel.innerHTML = `<div class="card"><div class="note warn">
            The review could not finish (${esc(err.message)}).
            <button class="btn small" id="retry-review">Try again</button></div></div>`;
          const retry = $('#retry-review');
          if (retry) retry.onclick = () => { ctrl = null; renderReview(); runReview(depth); };
        }
      }
    }
    ctrl = null;
  }

  function renderCoach() {
    const coach = $('#coach');
    if (!analysis) { coach.innerHTML = ''; return; }
    const mine = analysis.records.filter((r) => r.mover === g.myColor);
    const tally = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, 'missed-win': 0 };
    for (const r of mine) tally[classify(r)]++;
    const clean = mine.length
      ? Math.round(((tally.best + tally.excellent + tally.good) / mine.length) * 100)
      : 0;

    const turning = analysis.records
      .filter((r) => r.mover === g.myColor && r.severity && r.severity !== 'inaccuracy')
      .sort((a, b) => b.drop - a.drop)
      .slice(0, 3);

    coach.innerHTML = `
      <div class="card">
        <h2>Game report <span class="sub">depth ${analysis.depth}</span></h2>
        <div class="score-row">
          <div class="score"><b>${clean}%</b><span>clean moves</span></div>
          <div class="score"><b>${analysis.summary.acpl}</b><span>avg centipawn loss</span></div>
        </div>
        <div class="tally">
          ${[['best', 'best'], ['excellent', 'excellent'], ['good', 'good'],
             ['inaccuracy', 'inaccuracies'], ['mistake', 'mistakes'],
             ['blunder', 'blunders'], ['missed-win', 'missed wins']]
            .filter(([k]) => tally[k])
            .map(([k, label]) => `<span class="chip ${k}">${tally[k]} ${label}</span>`).join('')}
        </div>
        ${turning.length ? `
          <div class="sub" style="margin-top:12px">Turning points — tap to review:</div>
          ${turning.map((r) => `
            <button class="turning ${r.severity}" data-i="${r.i}">
              <b>${esc(r.label)} ${esc(r.san)}</b>
              <span class="sub">${dropDescription(r)}</span>
            </button>`).join('')}
        ` : `<p class="sub" style="margin-top:10px">No serious mistakes in this game. Well played.</p>`}
      </div>`;
    coach.onclick = (e) => {
      const b = e.target.closest('.turning');
      if (!b) return;
      goTo(parseInt(b.dataset.i, 10));
      $('#board').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  }

  $('#nav-start').onclick = () => goTo(0);
  $('#nav-prev').onclick = () => goTo(idx - 1);
  $('#nav-next').onclick = () => goTo(idx + 1);
  $('#nav-end').onclick = () => goTo(moves.length);

  document.onkeydown = (e) => {
    if (location.hash.startsWith('#g/')) {
      if (e.key === 'ArrowLeft') goTo(idx - 1);
      if (e.key === 'ArrowRight') goTo(idx + 1);
    }
  };

  let touchX = null;
  $('#board').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('#board').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) goTo(idx + (dx < 0 ? 1 : -1));
    touchX = null;
  }, { passive: true });

  renderGraph();
  renderMoveGrid();
  renderAnalyzeArea();
  renderCoach();
  goTo(0);

  // No analysis yet? Start one immediately rather than showing a button.
  if (!analysis && g.rules === 'chess') runReview(S.depth);
}

// ---------------------------------------------------------------- live play

async function renderPlay() {
  const level = LEVELS[S.playLevel ?? 2];
  const myColor = S.playColor || 'w';
  const chess = new Chess();
  const sans = [];
  let lastFromTo = null;
  let thinking = false;
  let finished = null;

  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#">←</a>
      <div><h1>Play</h1><div class="sub" id="p-sub">vs Stockfish · ${esc(level.name)}</div></div>
      <button class="btn small" id="p-new">New</button>
    </header>
    <div id="p-setup" class="card">
      <h2>Choose a level</h2>
      <div class="drill-picks">
        ${LEVELS.map((l) => `<button class="btn small level-pick ${l.id === level.id ? 'on' : ''}"
          data-level="${l.id}">${esc(l.name)} <i class="sub">${esc(l.elo)}</i></button>`).join('')}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn small colour-pick ${myColor === 'w' ? 'on' : ''}" data-colour="w">Play White</button>
        <button class="btn small colour-pick ${myColor === 'b' ? 'on' : ''}" data-colour="b">Play Black</button>
      </div>
      <button class="btn primary block" id="p-start">Start game</button>
    </div>
    <div id="p-game" hidden>
      <div class="board-wrap"><div id="board"></div></div>
      <div class="card" id="p-status"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn small" id="p-undo">Take back</button>
        <button class="btn small" id="p-resign">Resign</button>
      </div>
    </div>`;

  for (const b of document.querySelectorAll('.level-pick')) {
    b.onclick = () => { S.playLevel = +b.dataset.level; renderPlay(); };
  }
  for (const b of document.querySelectorAll('.colour-pick')) {
    b.onclick = () => { S.playColor = b.dataset.colour; renderPlay(); };
  }
  $('#p-new').onclick = () => renderPlay();

  let board = null;

  $('#p-start').onclick = async () => {
    $('#p-setup').hidden = true;
    $('#p-game').hidden = false;
    board = new Board($('#board'));
    board.setFlip(myColor === 'b');
    draw();
    if (myColor === 'b') await engineTurn();
  };

  const legalFrom = (sq) =>
    (chess.turn() === myColor && !thinking && !finished
      ? chess.moves({ square: sq, verbose: true }).map((m) => m.to)
      : []);

  function draw(msg) {
    board.position(chess.fen(), { lastMove: lastFromTo, arrows: [] });
    board.setInteractive(!finished && chess.turn() === myColor && !thinking, { legalFrom, onMove: human });
    const status = $('#p-status');
    if (!status) return;
    if (finished) {
      status.innerHTML = `
        <h2>${esc(finished.headline)}</h2>
        <p class="sub">${esc(finished.detail)}</p>
        <button class="btn primary block" id="p-review">Review this game</button>`;
      $('#p-review').onclick = () => reviewPracticeGame(finished.result);
      return;
    }
    status.innerHTML = `<b>${thinking ? 'Stockfish is thinking…' : (chess.turn() === myColor ? 'Your move' : '…')}</b>
      ${chess.inCheck() ? '<span class="sev blunder"> — check</span>' : ''}
      ${msg ? `<div class="sub">${esc(msg)}</div>` : ''}
      <div class="sub" style="margin-top:6px">${esc(sans.join(' ')) || 'No moves yet.'}</div>`;
  }

  function finish(reason, result) {
    const iWon = (result === '1-0' && myColor === 'w') || (result === '0-1' && myColor === 'b');
    const drawn = result === '1/2-1/2';
    finished = {
      result,
      headline: drawn ? 'Drawn.' : iWon ? 'You won.' : 'You lost.',
      detail: `By ${reason}. ${sans.length} moves played.`,
    };
    releaseEngine();
    draw();
  }

  async function human({ from, to }) {
    if (finished || thinking || chess.turn() !== myColor) return;
    let mv;
    try { mv = chess.move({ from, to, promotion: 'q' }); } catch { return; }
    if (!mv) return;
    sans.push(mv.san);
    lastFromTo = [mv.from, mv.to];
    const o = outcomeOf(chess);
    if (o.over) { finish(o.reason, o.result); return; }
    draw();
    await engineTurn();
  }

  async function engineTurn() {
    thinking = true;
    draw();
    try {
      const uci = await engineMove(chess.fen(), level);
      if (!uci) throw new Error('no move');
      const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
      sans.push(mv.san);
      lastFromTo = [mv.from, mv.to];
    } catch {
      thinking = false;
      draw('The engine stumbled — take back a move and try again.');
      return;
    }
    thinking = false;
    const o = outcomeOf(chess);
    if (o.over) { finish(o.reason, o.result); return; }
    draw();
  }

  $('#p-undo').onclick = () => {
    if (thinking || finished) return;
    // undo the pair, so it is your move again
    if (chess.history().length >= 2) { chess.undo(); chess.undo(); sans.splice(-2); }
    else if (chess.history().length === 1) { chess.undo(); sans.pop(); }
    const h = chess.history({ verbose: true });
    lastFromTo = h.length ? [h[h.length - 1].from, h[h.length - 1].to] : null;
    draw();
  };
  $('#p-resign').onclick = () => {
    if (finished) return;
    finish('resignation', myColor === 'w' ? '0-1' : '1-0');
  };

  async function reviewPracticeGame(result) {
    const pgn = buildPgn({ sans, myColor, level, result });
    const uuid = `practice-${Date.now()}`;
    const game = {
      uuid, url: '', pgn, endTime: Math.floor(Date.now() / 1000),
      timeClass: 'practice', rated: false, rules: 'chess',
      myColor, myRating: 0, myResultCode: 'practice',
      oppName: `Stockfish (${level.name})`, oppRating: 0,
      resultForMe: result === '1/2-1/2' ? 'D'
        : ((result === '1-0') === (myColor === 'w') ? 'W' : 'L'),
      opening: 'Practice game',
      practice: true,
    };
    S.games.unshift(game);
    S.practice.push(game);
    await idbPut('kv', 'practiceGames', S.practice);
    location.hash = `#g/${encodeURIComponent(uuid)}`;
  }
}

// ---------------------------------------------------------------- settings

async function renderSettings() {
  const spend = await getSpend();
  const usd = spendUsd(spend);
  const saved = hasApiKey();
  const masked = saved ? `${getApiKey().slice(0, 11)}…${getApiKey().slice(-4)}` : '';

  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#">←</a>
      <div><h1>Settings</h1></div>
      <span></span>
    </header>

    <div class="card">
      <h2>Written coaching from Claude</h2>
      <p class="sub">Everything else in this app is free and runs on your phone. This one
      feature calls Anthropic's API, which costs a small amount per explanation. It only
      ever runs when you press a button, and each explanation is saved forever, so you
      never pay twice for the same move.</p>

      ${saved ? `
        <div class="note good">Key saved on this device: <b>${esc(masked)}</b></div>
        <div class="score-row" style="margin-top:12px">
          <div class="score"><b>$${usd.toFixed(3)}</b><span>spent so far</span></div>
          <div class="score"><b>${spend.calls}</b><span>explanations</span></div>
        </div>
        <button class="btn" id="key-clear" style="margin-top:10px">Remove key from this device</button>
      ` : `
        <input id="key-in" type="password" placeholder="sk-ant-..." autocapitalize="none"
               autocorrect="off" spellcheck="false" />
        <button class="btn primary block" id="key-save">Save key on this device</button>
      `}
      <div id="key-msg" class="err"></div>
    </div>

    <div class="card">
      <h2>Before you paste a key</h2>
      <div class="note warn">Make a <b>separate</b> key for this app in the Anthropic Console
      and put a monthly spend limit on its workspace. Then the worst case is capped and you
      can revoke it in one click. Do not reuse a key you use for anything else.</div>
      <div class="note">The key is stored only in this browser's storage on this device. It
      is not in the app's public source code, and nobody else visiting the site has it. But
      anyone with access to this unlocked phone could read it, so treat it like a password.</div>
      <p class="sub">Model: Claude Sonnet 5. Roughly $0.02 per game, about $1.50 to explain
      every game you have ever played.</p>
    </div>`;

  const msg = $('#key-msg');
  if (saved) {
    $('#key-clear').onclick = () => { clearApiKey(); renderSettings(); };
  } else {
    $('#key-save').onclick = () => {
      const v = $('#key-in').value.trim();
      if (!v) return;
      if (!v.startsWith('sk-ant-')) {
        msg.textContent = 'That does not look like an Anthropic key (they start with sk-ant-).';
        return;
      }
      setApiKey(v);
      renderSettings();
    };
  }
}

// ---------------------------------------------------------------- openings

async function renderOpenings() {
  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#">←</a>
      <div><h1>Openings</h1><div class="sub">${S.games.length} games</div></div>
      <span></span>
    </header>
    <div class="center-note">Reading your openings…</div>`;

  await loadBook();
  const habits = habitReport(S.games);
  const report = openingReport(S.games, S.analyses);

  // Where do YOU leave known theory, and what does the book play instead?
  // Group identical departures so a habit shows up as a repeated one.
  const exits = new Map();
  for (const g of S.games) {
    const family = g.opening.split(' ').slice(0, 2).join(' ');
    try {
      const c = new Chess();
      c.loadPgn(g.pgn);
      const exit = bookExit(c.history(), g.myColor);
      if (!exit) continue;
      // A named-opening book is not a list of every good move: plenty of sound
      // moves are simply unnamed transpositions. Ask the engine what the move
      // actually cost before calling it a problem.
      const a = S.analyses.get(g.uuid);
      const rec = a ? a.records[exit.ply] : null;
      const bucket = exits.get(family) || { plies: [], spots: new Map() };
      bucket.plies.push(exit.ply);
      const key = `${exit.line.join(' ')}|${exit.played}`;
      const spot = bucket.spots.get(key) || { ...exit, count: 0, drops: [] };
      spot.count++;
      if (rec && rec.san === exit.played) spot.drops.push(rec.drop);
      bucket.spots.set(key, spot);
      exits.set(family, bucket);
    } catch { /* unparseable game, skip */ }
  }

  const failing = habits.filter((h) => !h.good);

  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#">←</a>
      <div><h1>Openings</h1><div class="sub">${S.games.length} games</div></div>
      <span></span>
    </header>

    <div class="card">
      <h2>Opening habits</h2>
      <p class="sub">These decide far more of your games than knowing theory does.</p>
      ${habits.map((h) => `
        <div class="habit ${h.good ? 'ok' : 'bad'}">
          <div class="habit-head">
            <b>${esc(h.label)}</b>
            <span class="habit-val">${esc(h.value)}</span>
          </div>
          <div class="sub">${esc(h.detail)}</div>
        </div>`).join('')}
      ${failing.length
        ? `<p class="why">Fix these first: <b>${failing.map((h) => esc(h.label.toLowerCase())).join(', ')}</b>.</p>`
        : `<p class="why">Your opening habits are sound. Theory is worth studying now.</p>`}
    </div>

    <div class="card">
      <div class="row-between"><h2>Drill your openings</h2></div>
      <p class="sub">Play through real theory move by move. The book replies, you find the next move.</p>
      <div class="drill-picks">
        ${report.slice(0, 6).map((o) => `
          <button class="btn small drill-pick" data-family="${esc(o.family)}">${esc(o.family)}</button>`).join('')}
        <button class="btn small drill-pick" data-family="">From move 1</button>
      </div>
    </div>

    <div class="card">
      <h2>Your openings</h2>
      ${report.map((o) => {
        const bucket = exits.get(o.family);
        const pct = Math.round(o.score * 100);
        // the departure you have repeated most often in this opening
        const top = bucket
          ? [...bucket.spots.values()].sort((a, b) => b.count - a.count)[0]
          : null;
        return `
          <div class="opening-block">
            <div class="row-between">
              <b>${esc(o.family)}</b>
              <span class="sub">${o.W}-${o.L}-${o.D} · ${pct}%</span>
            </div>
            <div class="wlbar">
              <i style="width:${(o.W / o.games) * 100}%"></i><u style="width:${(o.D / o.games) * 100}%"></u>
            </div>
            ${top ? (() => {
              const avgDrop = top.drops.length
                ? top.drops.reduce((s, x) => s + x, 0) / top.drops.length
                : null;
              const costly = avgDrop !== null && avgDrop >= THRESHOLD;
              const verdict = avgDrop === null
                ? 'Not analysed yet, so it may be perfectly sound.'
                : costly
                  ? `The engine says this costs about ${(avgDrop / 100).toFixed(1)} pawns — worth replacing.`
                  : 'The engine rates it fine, so this is a naming gap, not a mistake.';
              return `
              <div class="deviation ${costly ? 'costly' : ''}">
                On move ${top.moveNumber}, after <b>${esc(top.line.slice(-4).join(' ') || 'the first move')}</b>,
                you played <b>${esc(top.played)}</b>${top.count > 1 ? ` (${top.count} times)` : ''}
                instead of the book's <b>${esc(top.expected.slice(0, 3).join(', '))}</b>.
                ${esc(verdict)}
              </div>`;
            })() : `<div class="sub">You stay in book here.</div>`}
            <div class="sub">
              ${o.avgFirstMistake ? `First real mistake around move ${Math.max(1, Math.round(o.avgFirstMistake / 2))}.` : ''}
              ${o.analysed < o.games ? ` (${o.analysed}/${o.games} analysed)` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>`;

  for (const b of document.querySelectorAll('.drill-pick')) {
    b.onclick = () => { S.drillFamily = b.dataset.family; location.hash = '#drill'; };
  }
}

// ---------------------------------------------------------------- opening drill

async function renderDrill() {
  await loadBook(); // may be entered directly by reloading on #drill
  const family = S.drillFamily || '';
  // Play the colour you most often have in this opening.
  const inFamily = S.games.filter((g) => !family || g.opening.startsWith(family));
  const asWhite = inFamily.filter((g) => g.myColor === 'w').length;
  const myColor = family && inFamily.length ? (asWhite >= inFamily.length / 2 ? 'w' : 'b') : 'w';

  const chess = new Chess();
  const sans = [];
  let done = false;

  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#openings">←</a>
      <div><h1>${esc(family || 'Opening drill')}</h1><div class="sub" id="d-line"></div></div>
      <span></span>
    </header>
    <div class="card" id="d-prompt"></div>
    <div class="board-wrap"><div id="board"></div></div>
    <div id="d-feedback"></div>`;

  const board = new Board($('#board'));
  board.setFlip(myColor === 'b');
  const legalFrom = (sq) => chess.moves({ square: sq, verbose: true }).map((m) => m.to);

  function bookMoves() {
    const all = bookAt(sans).continuations.filter((c) => chess.moves().includes(c.san));
    if (!family) return all;
    // inside a chosen opening, only its own continuations count as "the book"
    const inFamily = all.filter((c) => c.names.some((n) => n.startsWith(family)));
    return inFamily.length ? inFamily : all;
  }

  function draw(msg = '') {
    const info = bookAt(sans);
    board.position(chess.fen(), {
      lastMove: sans.length ? lastFromTo : null,
      arrows: [],
    });
    $('#d-line').textContent = sans.length ? sans.join(' ') : 'starting position';
    const options = bookMoves();
    if (!options.length || done) {
      done = true;
      board.setInteractive(false);
      $('#d-prompt').innerHTML = `<h2>${esc(info.name || 'Out of book')}</h2>
        <p class="sub">This is as far as the book goes.</p>`;
      $('#d-feedback').innerHTML = `<div class="card">
        <p>You played: <b>${esc(sans.join(' ')) || '(nothing)'}</b></p>
        <div class="row">
          <button class="btn primary" id="d-continue">Keep playing — coached</button>
          <button class="btn small" id="d-again">Start again</button>
          <a class="btn small" href="#openings">Back</a>
        </div></div>`;
      $('#d-continue').onclick = () => startFreePlay();
      $('#d-again').onclick = () => renderDrill();
      return;
    }
    $('#d-prompt').innerHTML = `
      <h2>${esc(info.name || 'Opening drill')}</h2>
      <p class="sub">${myColor === 'w' ? 'White' : 'Black'} to play — find a move theory plays here.
      ${options.length} known continuation${options.length === 1 ? '' : 's'}.</p>`;
    $('#d-feedback').innerHTML = msg;
    board.setInteractive(true, { legalFrom, onMove: attempt });
  }

  let lastFromTo = null;

  function replyFromBook() {
    const pick = pickBookMove(sans, family);
    if (!pick || !chess.moves().includes(pick.san)) { done = true; return null; }
    const fenBefore = chess.fen();
    const mover = chess.turn();
    const mv = chess.move(pick.san);
    sans.push(mv.san);
    lastFromTo = [mv.from, mv.to];
    // "brings a new piece into the game", "takes space in the centre", ...
    const raw = describeBestMove({
      fenBefore, mover, bestUci: `${mv.from}${mv.to}${mv.promotion || ''}`,
    });
    const idea = raw.replace(/^\*\*.+?\*\* was the move: it /, '').replace(/\.$/, '');
    return { san: mv.san, idea: idea === raw ? '' : idea };
  }

  // Once a line leaves the book, the coached loop takes over: the engine plays
  // the other side and every move of yours gets a verdict.
  function startFreePlay() {
    done = true;
    $('#d-prompt').innerHTML = `<h2>${esc(bookAt(sans).name || family || 'Your game')}</h2>
      <p class="sub">Out of the book — now it is chess. The engine answers, and every move
      of yours gets a verdict. Mistakes pause the game so you can retry them.</p>`;
    const footer = `<div class="row" style="margin-top:8px">
      <button class="btn small" id="d-again2">Start again</button>
      <a class="btn small" href="#openings">Back to openings</a></div>`;
    const bind = () => { const b = $('#d-again2'); if (b) b.onclick = () => renderDrill(); };
    runCoachedLoop({
      board, chess, myColor, level: LEVELS[3],
      panelEl: '#d-feedback', footer, bindFooter: bind,
    });
  }

  async function attempt({ from, to }) {
    if (done) return;
    // Work out the book moves while the position is still the one being asked
    // about; playing first would leave chess.moves() listing the opponent's
    // replies instead.
    const options = bookMoves().map((c) => c.san);
    let mv;
    try { mv = chess.move({ from, to, promotion: 'q' }); } catch { return; }
    if (!mv) return;

    const ok = options.includes(mv.san);
    if (!ok) {
      // Off the book path. The book only knows NAMED moves, so ask the engine
      // whether the move is actually bad before saying anything discouraging.
      board.setInteractive(false);
      $('#d-feedback').innerHTML = `<div class="card"><p class="sub">Not a book move — asking the engine what it thinks…</p></div>`;
      const fenAfter = chess.fen();
      chess.undo();
      const fenBefore = chess.fen();
      let beforeEv, afterEv;
      try {
        beforeEv = await evalWhite(fenBefore, 12);
        afterEv = await evalWhite(fenAfter, 12);
      } catch {
        draw(`<div class="card bad"><h2>✗ ${esc(mv.san)} is not in the book here.</h2>
          <p>Theory plays: <b>${options.slice(0, 4).map(esc).join(', ')}</b>.</p></div>`);
        return;
      }
      if (!document.contains(board.el)) return;
      const drop = myColor === 'w' ? beforeEv.cp - afterEv.cp : afterEv.cp - beforeEv.cp;

      if (drop >= THRESHOLD) {
        const rec = {
          label: '', san: mv.san, mover: myColor, before: beforeEv.cp, after: afterEv.cp,
          drop, fenBefore, played: { from, to }, bestUci: beforeEv.pv[0] || null, bestLine: '',
        };
        const next = { fenBefore: fenAfter, bestUci: afterEv.pv[0] || null, bestLine: '' };
        draw(`<div class="card bad">
          <h2>✗ ${esc(mv.san)} is not book — and it loses material.</h2>
          <p class="why">${rich(explainMistake(rec, next))}</p>
          <p>Theory plays <b>${options.slice(0, 3).map(esc).join(', ')}</b>. The position is back — try one.</p>
        </div>`);
        return;
      }

      // Sound, just unnamed. That is a real choice, not an error.
      board.setInteractive(false);
      $('#d-feedback').innerHTML = `<div class="card">
        <h2>${esc(mv.san)} is not in the book, but it is a fine move.</h2>
        <p class="sub">The engine says it costs ${drop <= 0 ? 'nothing at all' : `only ${(drop / 100).toFixed(1)} pawns`}.
        Theory prefers <b>${options.slice(0, 3).map(esc).join(', ')}</b>. Your call:</p>
        <div class="row">
          <button class="btn small primary" id="d-playit">Play it — coached from here</button>
          <button class="btn small" id="d-stay">Take back, stay in theory</button>
        </div></div>`;
      $('#d-playit').onclick = () => {
        chess.move({ from, to, promotion: 'q' });
        sans.push(mv.san);
        lastFromTo = [from, to];
        startFreePlay();
      };
      $('#d-stay').onclick = () => draw();
      return;
    }

    sans.push(mv.san);
    lastFromTo = [mv.from, mv.to];
    const named = bookAt(sans);
    board.setInteractive(false);
    // book plays its reply
    setTimeout(() => {
      const reply = replyFromBook();
      draw(`<div class="card good"><h2>✓ ${esc(mv.san)}</h2>
        <p class="sub">${esc(named.name || 'Still in book')}.${
          reply ? ` Book answers <b>${esc(reply.san)}</b>${reply.idea ? ` — ${esc(reply.idea)}` : ''}.` : ''}</p></div>`);
    }, 350);
  }

  // if you are Black, the book opens for White first
  if (myColor === 'b') replyFromBook();
  draw();
}

// ---------------------------------------------------------------- trainer

// ---------------------------------------------------------------- coached play
//
// The loop that makes Train and Openings feel like the game review: you keep
// playing, the engine answers, and every move of yours gets a verdict in plain
// words. Bad moves pause the game with the same explanation the review gives,
// plus take-back-and-retry.

async function runCoachedLoop({ board, chess, myColor, level, panelEl, footer = '', bindFooter, firstNote = '' }) {
  const alive = () => document.contains(board.el);
  const say = (html) => {
    if (!alive()) return;
    const el = $(panelEl);
    if (el) {
      el.innerHTML = `<div class="card">${html}${footer}</div>`;
      if (bindFooter) bindFooter();
    }
  };

  let cp = null, pv = []; // white-view eval + engine line for the user-to-move position
  let note = firstNote;   // one-liner about the user's previous move

  const lastFromTo = () => {
    const h = chess.history({ verbose: true });
    return h.length ? [h[h.length - 1].from, h[h.length - 1].to] : null;
  };
  const redraw = (arrows = []) => board.position(chess.fen(), { lastMove: lastFromTo(), arrows });
  const legalFrom = (sq) => chess.moves({ square: sq, verbose: true }).map((m) => m.to);

  function gameOverCard() {
    const o = outcomeOf(chess);
    if (!o.over) return false;
    board.setInteractive(false);
    const drawn = o.result === '1/2-1/2';
    const iWon = !drawn && (o.result === '1-0') === (myColor === 'w');
    say(`${note ? `<p class="why">${esc(note)}</p>` : ''}
      <h2>${drawn ? 'Drawn' : iWon ? 'You won' : 'You lost'} — ${esc(o.reason)}.</h2>`);
    return true;
  }

  function standingText() {
    const u = myColor === 'w' ? cp : -cp;
    if (isMateScore(cp)) {
      return u > 0 ? 'You have a forced mate — finish it.' : 'You are getting mated — defend.';
    }
    if (Math.abs(u) < 30) return 'The position is level.';
    return `${(Math.abs(u) / 100).toFixed(1)} pawns ${u > 0 ? 'in your favour' : 'against you'}.`;
  }

  function yourTurn(headline = '') {
    if (!alive() || gameOverCard()) return;
    const fullmove = parseInt(chess.fen().split(' ')[5], 10);
    const warn = positionNotes(chess.fen(), myColor, fullmove).find((n) => n.kind === 'warn');
    say(`
      ${note ? `<p class="why">${esc(note)}</p>` : ''}
      ${headline || '<h2>Your move.</h2>'}
      ${cp !== null ? `<p class="sub">${esc(standingText())}</p>` : ''}
      ${warn ? `<div class="note warn">${esc(warn.text)}</div>` : ''}
      <div class="row">
        <button class="btn small" id="cl-hint">Hint</button>
        <button class="btn small" id="cl-back" ${chess.history().length >= 2 ? '' : 'disabled'}>Take back</button>
      </div>`);
    note = '';
    const hint = $('#cl-hint');
    if (hint) hint.onclick = () => {
      if (pv[0]) redraw([{ from: pv[0].slice(0, 2), to: pv[0].slice(2, 4), kind: 'best' }]);
    };
    const back = $('#cl-back');
    if (back) back.onclick = () => {
      if (chess.history().length >= 2) { chess.undo(); chess.undo(); }
      redraw();
      startTurn('<h2>Back a move — try again.</h2>');
    };
    board.setInteractive(true, { legalFrom, onMove: userMove });
  }

  async function startTurn(headline = '') {
    say(`${note ? `<p class="why">${esc(note)}</p>` : ''}<p class="sub">Reading the position…</p>`);
    try {
      const r = await evalWhite(chess.fen(), 12);
      cp = r.cp; pv = r.pv;
    } catch { /* coach silently sits out this move */ }
    yourTurn(headline);
  }

  async function userMove({ from, to }) {
    const fenBefore = chess.fen();
    const baseCp = cp, basePv = pv;
    let mv;
    try { mv = chess.move({ from, to, promotion: 'q' }); } catch { return; }
    if (!mv) return;
    redraw();
    board.setInteractive(false);
    if (gameOverCard()) return;

    say('<p class="sub">Checking your move…</p>');
    let after;
    try {
      after = await evalWhite(chess.fen(), 12);
    } catch {
      if (alive()) opponentTurn();
      return;
    }
    if (!alive()) return;
    const drop = baseCp === null ? 0 : (myColor === 'w' ? baseCp - after.cp : after.cp - baseCp);

    if (drop >= THRESHOLD) {
      // Pause and coach, exactly like the review card would.
      const rec = {
        label: '', san: mv.san, mover: myColor, before: baseCp, after: after.cp,
        drop, fenBefore, played: { from, to }, bestUci: basePv[0] || null, bestLine: '',
      };
      const sev = severity(rec) || 'mistake';
      const next = { fenBefore: chess.fen(), bestUci: after.pv[0] || null, bestLine: '' };
      redraw(after.pv[0]
        ? [{ from: after.pv[0].slice(0, 2), to: after.pv[0].slice(2, 4), kind: 'played' }]
        : []);
      say(`
        <div class="review-head">
          <span class="verdict ${sev}">${VERDICT_LABEL[sev] || 'Mistake'}</span>
          <b class="review-move">${esc(mv.san)}</b>
        </div>
        <p class="why">${rich(explainMistake(rec, next))}</p>
        ${next.bestUci ? '<p class="sub">Red shows how it gets punished.</p>' : ''}
        <div class="row">
          <button class="btn small primary" id="cl-retry">Take back & retry</button>
          <button class="btn small" id="cl-goon">Play on anyway</button>
        </div>`);
      const retry = $('#cl-retry');
      if (retry) retry.onclick = () => {
        chess.undo();
        cp = baseCp; pv = basePv;
        redraw();
        yourTurn('<h2>Same position — find a better move.</h2>');
      };
      const goon = $('#cl-goon');
      if (goon) goon.onclick = () => { cp = after.cp; pv = after.pv; opponentTurn(); };
      return;
    }

    cp = after.cp; pv = after.pv;
    const playedBest = basePv[0] && `${from}${to}` === basePv[0].slice(0, 4);
    note = playedBest ? `★ ${mv.san} — the engine's own choice.`
      : drop <= 20 ? `✓ ${mv.san} — good.`
      : `${mv.san} is okay, but gives back ${(Math.max(0, drop) / 100).toFixed(1)} pawns.`;
    opponentTurn();
  }

  async function opponentTurn() {
    if (!alive() || gameOverCard()) return;
    say(`${note ? `<p class="why">${esc(note)}</p>` : ''}<p class="sub">Engine is replying…</p>`);
    let uci = null;
    try { uci = await engineMove(chess.fen(), level); } catch { /* fall through */ }
    if (!alive()) return;
    if (!uci || !chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' })) {
      startTurn();
      return;
    }
    redraw();
    if (gameOverCard()) return;
    startTurn();
  }

  redraw();
  if (gameOverCard()) return;
  if (chess.turn() !== myColor) await opponentTurn();
  else await startTurn();
}

// A puzzle has one engine answer, but chess usually offers several good moves.
// Accept anything that keeps the evaluation within this many centipawns.
const NEAR_ENOUGH = 50;

// Who you play against once you have found the move. Strong enough that the
// continuation is worth learning from, not so strong that converting is hopeless.
const PLAY_OUT_LEVEL = LEVELS[3];

async function renderTrain() {
  let queue = buildQueue(S.games, S.analyses, S.progress, { now: Date.now() });
  if (!queue.length) {
    // nothing scheduled: fall back to a free practice run over everything
    queue = buildQueue(S.games, S.analyses, S.progress, { now: 0 });
  }
  if (!queue.length) {
    $('#view').innerHTML = `
      <header class="top"><a class="btn small" href="#">←</a><h1>Training</h1><span></span></header>
      <div class="card center-note">Analyze some games first and your mistakes will show up here as puzzles.</div>`;
    return;
  }

  let pos = 0;
  let answered = false;
  let tries = 0;
  let right = 0, wrong = 0;

  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#">←</a>
      <div><h1>Training</h1><div class="sub" id="t-count"></div></div>
      <div class="sub" id="t-score"></div>
    </header>
    <div class="card" id="t-prompt"></div>
    <div class="board-wrap"><div id="board"></div></div>
    <div id="t-feedback"></div>`;

  const board = new Board($('#board'));
  let chess = null;
  let puzzle = null;

  const legalFrom = (sq) => (chess ? chess.moves({ square: sq, verbose: true }).map((m) => m.to) : []);

  function show() {
    puzzle = queue[pos];
    window.__kcPuzzle = puzzle; // debug/test hook, carries no secrets
    answered = false;
    tries = 0;
    const r = puzzle.record;
    chess = new Chess(r.fenBefore);
    board.setFlip(puzzle.myColor === 'b');
    board.position(r.fenBefore, { lastMove: null, arrows: [] });
    board.setInteractive(true, { legalFrom, onMove: attempt });

    $('#t-count').textContent = `${pos + 1} of ${queue.length}`;
    $('#t-score').textContent = right + wrong ? `${right} right · ${wrong} wrong` : '';
    $('#t-prompt').innerHTML = `
      <h2>${puzzle.myColor === 'w' ? 'White' : 'Black'} to play — find the move</h2>
      <p class="sub">From your game against ${esc(puzzle.oppName)} (${esc(puzzle.opening)}).
      You went wrong here and it ${dropDescription(r)}.</p>`;
    $('#t-feedback').innerHTML = '';
  }

  // Getting it wrong should send you back to the position, not hand you the
  // answer. The spaced-repetition card is still graded on the FIRST try, so
  // retrying to understand a position never inflates the schedule.
  async function attempt({ from, to }) {
    if (answered) return;
    let mv;
    try {
      mv = chess.move({ from, to, promotion: 'q' });
    } catch { return; }
    if (!mv) return;

    tries++;
    board.setInteractive(false);
    board.position(chess.fen(), { lastMove: [from, to], arrows: [] });

    const r = puzzle.record;
    const best = r.bestUci;
    let correct = best && (`${from}${to}` === best.slice(0, 4));
    let verdict = '';

    if (correct) {
      verdict = 'Right.';
    } else {
      $('#t-feedback').innerHTML = `<div class="card sub">Checking your move…</div>`;
      try {
        const eng = await getEngine();
        const info = await eng.evalPosition(chess.fen(), puzzle.depth || S.depth);
        const mine = info.type === 'mate'
          ? (info.value > 0 ? -(MATE_CP - info.value) : MATE_CP + info.value)
          : -info.value;
        const lost = (r.mover === 'w' ? r.before : -r.before) - mine;
        if (isMateScore(mine) && mine < 0) {
          verdict = `${mv.san} runs into a forced mate in ${MATE_CP - Math.abs(mine)}.`;
        } else if (lost <= NEAR_ENOUGH) {
          correct = true;
          verdict = `Right — ${mv.san} is as good as the engine's own move.`;
        } else {
          verdict = `${mv.san} loses about ${(lost / 100).toFixed(1)} pawns.`;
        }
      } catch {
        verdict = `${mv.san} is not the move.`;
      }
    }

    // Only the first attempt counts toward the ladder.
    if (tries === 1) {
      gradeCard(S.progress, puzzle.id, correct, Date.now());
      await saveProgress(S.progress);
      if (correct) right++; else wrong++;
      $('#t-score').textContent = `${right} right · ${wrong} wrong`;
    }

    if (!correct) {
      chess.undo();
      board.position(chess.fen(), { lastMove: null, arrows: [] });
      board.setInteractive(true, { legalFrom, onMove: attempt });
      $('#t-feedback').innerHTML = `
        <div class="card bad">
          <h2>✗ ${esc(verdict)}</h2>
          <p class="sub">Have another go — the position is back as it was.${
            tries > 1 ? ` That's ${tries} tries.` : ''}</p>
          <div class="row">
            <button class="btn small" id="t-show">Show me the move</button>
            <button class="btn small" id="t-skip">Skip this one</button>
          </div>
        </div>`;
      $('#t-show').onclick = () => reveal();
      $('#t-skip').onclick = () => nextPuzzle();
      return;
    }

    answered = true;
    await playOut(verdict);
  }

  /** Give up on this position: show the move and why the game move failed. */
  function reveal() {
    answered = true;
    const r = puzzle.record;
    const bestSan = r.bestLine ? r.bestLine.replace(/^\d+\.+\s*/, '').split(' ')[0] : '?';
    board.setInteractive(false);
    if (r.bestUci) {
      board.position(chess.fen(), {
        lastMove: null,
        arrows: [{ from: r.bestUci.slice(0, 2), to: r.bestUci.slice(2, 4), kind: 'best' }],
      });
    }
    $('#t-feedback').innerHTML = `
      <div class="card">
        <h2>The move was <b>${esc(bestSan)}</b>.</h2>
        <p class="sub" style="margin-top:8px">In the game you played <b>${esc(r.san)}</b>:</p>
        <p class="why">${rich(explainMistake(r, puzzle.next))}</p>
        <div class="row">
          <button class="btn primary" id="t-next">${pos + 1 < queue.length ? 'Next position' : 'Finish'}</button>
          <a class="btn small" href="#g/${encodeURIComponent(puzzle.gameUuid)}">See the game</a>
        </div>
      </div>`;
    $('#t-next').onclick = nextPuzzle;
  }

  /**
   * Finding the move is half of it. Converting the position you just won is the
   * half that actually shows up in your next game, so the coached loop takes
   * over from here: the engine answers each move and every one of yours gets a
   * verdict, exactly like the game review.
   */
  async function playOut(verdict) {
    const footer = `
      <div class="row" style="margin-top:8px">
        <button class="btn primary" id="t-next">${pos + 1 < queue.length ? 'Next position' : 'Finish'}</button>
        <a class="btn small" href="#g/${encodeURIComponent(puzzle.gameUuid)}">See the game</a>
      </div>`;
    const bind = () => { const n = $('#t-next'); if (n) n.onclick = nextPuzzle; };
    await runCoachedLoop({
      board, chess, myColor: puzzle.myColor, level: PLAY_OUT_LEVEL,
      panelEl: '#t-feedback', footer, bindFooter: bind,
      firstNote: `✓ ${verdict} Now play it out.`,
    });
  }

  function nextPuzzle() {
    if (pos + 1 < queue.length) { pos++; show(); }
    else location.hash = '';
  }

  show();
}

// ---------------------------------------------------------------- go

// Offline caching needs a secure context (https, or localhost during dev).
// Over plain http on the LAN the app still works; it just isn't cached.
if ('serviceWorker' in navigator && window.isSecureContext) {
  // A worker that never checks for a newer version leaves the phone running
  // whatever code it first installed. Ask on every load, and when a new one
  // takes over (the worker calls skipWaiting + claim), reload once so the
  // page is actually running the code that just arrived.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  // updateViaCache: 'none' keeps the browser from serving sw.js itself out of
  // the HTTP cache. GitHub Pages sets max-age on everything, so without this
  // the worker that decides how everything else is cached is the one file that
  // can never be refreshed.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => reg.update())
    .catch(() => {});
}
boot();
