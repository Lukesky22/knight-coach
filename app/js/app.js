// Knight Coach — app shell, views, replay, and coach UI.

import { idbGet, idbPut, idbGetAll } from './db.js';
import { getProfile, syncGames, loadCachedGames } from './chesscom.js';
import { Board } from './board.js';
import {
  analyzeGame, parseGame, fmtEval, isMateScore, explainMistake, dropDescription,
  classify, positionNotes, VERDICT_LABEL, getEngine, MATE_CP, THRESHOLD,
} from './analysis.js';
import { buildQueue, gradeCard, getProgress, saveProgress, stats } from './trainer.js';
import { loadBook, bookAt, bookExit, pickBookMove, habitReport, openingReport } from './openings.js';
import {
  hasApiKey, getApiKey, setApiKey, clearApiKey,
  explainMove, cachedExplanation, getSpend, spendUsd,
} from './explain.js';
import { Chess } from '../vendor/chess.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const S = {
  user: localStorage.getItem('kc.user') || '',
  depth: parseInt(localStorage.getItem('kc.depth') || '14', 10),
  games: [],
  analyses: new Map(), // uuid -> analysis result
  bulk: null,          // AbortController while "analyze all" runs
  offline: false,
  progress: null,      // trainer spaced-repetition state
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
  const before = S.games.length ? S.games.length : null;
  S.syncError = null;
  try {
    S.games = await syncGames(S.user, (i, n) => {
      view.innerHTML = `<div class="center-note">Fetching archives ${i}/${n}…</div>`;
    });
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
            <span class="opp">${esc(x.oppName)} <i>(${x.oppRating})</i></span>
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

  const resultText = { W: 'You won', L: 'You lost', D: 'Draw' }[g.resultForMe];

  $('#view').innerHTML = `
    <header class="top">
      <a class="btn small" href="#">←</a>
      <div>
        <h1>vs ${esc(g.oppName)} (${g.oppRating})</h1>
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

    <div class="controls">
      <button class="btn nav" id="nav-start">⏮</button>
      <button class="btn nav" id="nav-prev">◀</button>
      <div class="eval-read" id="eval-read">—</div>
      <button class="btn nav" id="nav-next">▶</button>
      <button class="btn nav" id="nav-end">⏭</button>
    </div>

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
    idx = Math.max(0, Math.min(moves.length, newIdx));
    drawCurrent();
    for (const el of document.querySelectorAll('.mv')) el.classList.remove('cur');
    if (idx > 0) $(`.mv[data-i="${idx}"]`)?.classList.add('cur');
    updateEvalUI();
    renderReview();
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

  // Board for the move you are standing on: the move played in red, and the
  // move that was better in green whenever they differ.
  function drawCurrent() {
    const rec = recAt(idx);
    const arrows = [];
    if (rec) {
      const bestSame = rec.bestUci
        && rec.bestUci.slice(0, 4) === `${rec.played.from}${rec.played.to}`;
      if (!bestSame && rec.bestUci && rec.drop >= 20) {
        arrows.push({ from: rec.played.from, to: rec.played.to, kind: 'played' });
        arrows.push({ from: rec.bestUci.slice(0, 2), to: rec.bestUci.slice(2, 4), kind: 'best' });
      }
    }
    board.position(fenAt(idx), {
      lastMove: idx > 0 ? [moves[idx - 1].from, moves[idx - 1].to] : null,
      arrows,
    });
    renderStrips();
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
      panel.innerHTML = `<div class="card sub">Analyze this game to get move-by-move coaching.</div>`;
      return;
    }
    const rec = recAt(idx);
    if (!rec) {
      const notes = positionNotes(fenAt(idx), g.myColor, 1);
      panel.innerHTML = `<div class="card">
        <h2>Starting position</h2>
        <p class="sub">Step forward with ▶ (or swipe the board). Every move you made gets a verdict, and when there was something better you will see it in green.</p>
        ${notes.map((n) => `<div class="note ${n.kind}">${esc(n.text)}</div>`).join('')}
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
          <p class="why">${esc(explainMistake(rec, nextRec))}</p>
          <div class="legend">
            <span><i class="sw played"></i>what you played</span>
            <span><i class="sw best"></i>what was better</span>
          </div>
          <div class="row">
            <button class="btn small" id="show-line">▶ Watch the better line</button>
            <button class="btn small" id="try-here">Try it yourself</button>
            ${hasApiKey() ? `<button class="btn small" id="ask-coach">Ask the coach</button>` : ''}
          </div>
          <div class="sub" id="line-status"></div>
          <div id="coach-text"></div>
        ` : bad ? `
          <p class="why">${esc(g.oppName)} slipped here — ${esc(explainMistake(rec, nextRec))}</p>
        ` : verdict === 'best' ? `
          <p class="why">You found the engine's first choice.</p>
        ` : `
          <p class="why">Fine. The evaluation barely moved${rec.bestLine ? `; the engine's line was ${esc(rec.bestLine)}` : ''}.</p>
        `}

        ${notes.length ? `<div class="notes-block">
          <div class="sub">In this position:</div>
          ${notes.map((n) => `<div class="note ${n.kind}">${esc(n.text)}</div>`).join('')}
        </div>` : ''}
      </div>`;

    const showBtn = $('#show-line');
    if (showBtn) showBtn.onclick = playBetterLine;
    const tryBtn = $('#try-here');
    if (tryBtn) tryBtn.onclick = () => tryHere(rec);
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
  function tryHere(rec) {
    const line = new Chess(rec.fenBefore);
    board.position(rec.fenBefore, { lastMove: null, arrows: [] });
    board.setInteractive(true, {
      legalFrom: (sq) => line.moves({ square: sq, verbose: true }).map((m) => m.to),
      onMove: ({ from, to }) => {
        let mv;
        try { mv = line.move({ from, to, promotion: 'q' }); } catch { return; }
        if (!mv) return;
        const right = rec.bestUci && rec.bestUci.slice(0, 4) === `${from}${to}`;
        board.setInteractive(false);
        board.position(line.fen(), { lastMove: [from, to], arrows: [] });
        $('#line-status').innerHTML = right
          ? `<b style="color:var(--green)">✓ ${esc(mv.san)} — that's the move.</b>`
          : `<b style="color:var(--red)">✗ ${esc(mv.san)}</b> — the move was <b>${esc((rec.bestLine || '').replace(/^\d+\.+\s*/, '').split(' ')[0] || '?')}</b>.`;
        setTimeout(() => { drawCurrent(); }, 1600);
      },
    });
    $('#line-status').textContent = 'Your move — play it on the board.';
  }

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
    area.innerHTML = `
      <div class="card">
        <div class="row">
          <label class="sub">Depth
            <select id="g-depth">${[10, 12, 14, 16, 18].map((d) =>
              `<option ${d === S.depth ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </label>
          <button id="g-analyze" class="btn primary">${analysis ? `Re-analyze (now d${analysis.depth})` : 'Analyze this game'}</button>
        </div>
        <div class="progress" id="g-bar-wrap" hidden><div id="g-bar"></div></div>
      </div>`;
    $('#g-depth').onchange = (e) => {
      S.depth = parseInt(e.target.value, 10);
      localStorage.setItem('kc.depth', String(S.depth));
    };
    $('#g-analyze').onclick = async () => {
      const btn = $('#g-analyze');
      if (ctrl) { ctrl.abort(); return; }
      ctrl = new AbortController();
      btn.textContent = 'Stop';
      $('#g-bar-wrap').hidden = false;
      try {
        const a = await analyzeGame({
          pgn: g.pgn, myColor: g.myColor, depth: S.depth, signal: ctrl.signal,
          onProgress: (p, n) => { $('#g-bar').style.width = `${(p / n) * 100}%`; },
        });
        await idbPut('analyses', g.uuid, a);
        S.analyses.set(g.uuid, a);
        analysis = a;
        rebuildFlagMap();
        renderGraph(); renderMoveGrid(); renderCoach(); renderAnalyzeArea();
        goTo(idx);
      } catch (err) {
        if (!err.cancelled) {
          console.error(err);
          $('#g-bar-wrap').hidden = true;
          btn.textContent = 'Analyze this game';
        } else {
          renderAnalyzeArea();
        }
      }
      ctrl = null;
    };
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
        <p class="sub">This is as far as the book goes. From here it is your own chess.</p>`;
      $('#d-feedback').innerHTML = `<div class="card">
        <p>You played: <b>${esc(sans.join(' ')) || '(nothing)'}</b></p>
        <div class="row">
          <button class="btn primary" id="d-again">Start again</button>
          <a class="btn small" href="#openings">Back to openings</a>
        </div></div>`;
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
    if (!pick || !chess.moves().includes(pick.san)) { done = true; return; }
    const mv = chess.move(pick.san);
    sans.push(mv.san);
    lastFromTo = [mv.from, mv.to];
  }

  function attempt({ from, to }) {
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
      chess.undo();
      draw(`<div class="card bad">
        <h2>✗ ${esc(mv.san)} is not in the book here.</h2>
        <p>Theory plays: <b>${options.slice(0, 4).map(esc).join(', ')}</b>.</p>
        <p class="sub">That does not make your move losing — it just leaves known paths, and at your level that usually means facing prepared opponents without a map.</p>
      </div>`);
      return;
    }
    sans.push(mv.san);
    lastFromTo = [mv.from, mv.to];
    const named = bookAt(sans);
    board.setInteractive(false);
    // book plays its reply
    setTimeout(() => {
      replyFromBook();
      draw(`<div class="card good"><h2>✓ ${esc(mv.san)}</h2>
        <p class="sub">${esc(named.name || 'Still in book')}.</p></div>`);
    }, 350);
  }

  // if you are Black, the book opens for White first
  if (myColor === 'b') replyFromBook();
  draw();
}

// ---------------------------------------------------------------- trainer

// A puzzle has one engine answer, but chess usually offers several good moves.
// Accept anything that keeps the evaluation within this many centipawns.
const NEAR_ENOUGH = 50;

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
    answered = false;
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

  async function attempt({ from, to }) {
    if (answered) return;
    let mv;
    try {
      mv = chess.move({ from, to, promotion: 'q' });
    } catch { return; }
    if (!mv) return;
    answered = true;
    board.setInteractive(false);
    board.position(chess.fen(), { lastMove: [from, to], arrows: [] });

    const r = puzzle.record;
    const best = r.bestUci;
    const played = `${from}${to}`;
    let correct = best && (played === best.slice(0, 4));
    let verdict = '';

    if (correct) {
      verdict = 'Exactly right.';
    } else {
      $('#t-feedback').innerHTML = `<div class="card sub">Checking your move…</div>`;
      try {
        const eng = await getEngine();
        const info = await eng.evalPosition(chess.fen(), 12);
        // score is from the new side-to-move's view; flip to yours
        const mine = info.type === 'mate'
          ? (info.value > 0 ? -(MATE_CP - info.value) : MATE_CP + info.value)
          : -info.value;
        const lost = (r.mover === 'w' ? r.before : -r.before) - mine;
        if (isMateScore(mine) && mine < 0) {
          verdict = `That runs into a forced mate in ${MATE_CP - Math.abs(mine)}.`;
        } else if (lost <= NEAR_ENOUGH) {
          correct = true;
          verdict = `Good move — the engine rates ${mv.san} about as highly as its own choice.`;
        } else {
          verdict = `${mv.san} loses about ${(lost / 100).toFixed(1)} pawns.`;
        }
      } catch {
        verdict = 'Not the move.';
      }
    }

    gradeCard(S.progress, puzzle.id, correct, Date.now());
    await saveProgress(S.progress);
    if (correct) right++; else wrong++;
    $('#t-score').textContent = `${right} right · ${wrong} wrong`;

    const bestSan = r.bestLine ? r.bestLine.replace(/^\d+\.+\s*/, '').split(' ')[0] : '?';
    $('#t-feedback').innerHTML = `
      <div class="card ${correct ? 'good' : 'bad'}">
        <h2>${correct ? '✓ ' : '✗ '}${esc(verdict)}</h2>
        ${correct ? '' : `<p>The move was <b>${esc(bestSan)}</b>.</p>`}
        <p class="sub" style="margin-top:8px">In the game you played <b>${esc(r.san)}</b>:</p>
        <p class="why">${esc(explainMistake(r, puzzle.next))}</p>
        <div class="row">
          <button class="btn primary" id="t-next">${pos + 1 < queue.length ? 'Next position' : 'Finish'}</button>
          <a class="btn small" href="#g/${encodeURIComponent(puzzle.gameUuid)}">See the game</a>
        </div>
      </div>`;
    $('#t-next').onclick = () => {
      if (pos + 1 < queue.length) { pos++; show(); }
      else location.hash = '';
    };
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
  navigator.serviceWorker.register('sw.js')
    .then((reg) => reg.update())
    .catch(() => {});
}
boot();
