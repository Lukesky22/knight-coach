// Knight Coach — app shell, views, replay, and coach UI.

import { idbGet, idbPut, idbGetAll } from './db.js';
import { getProfile, syncGames, loadCachedGames } from './chesscom.js';
import { Board } from './board.js';
import {
  analyzeGame, parseGame, fmtEval, isMateScore, explainMistake, dropDescription,
  getEngine, MATE_CP, THRESHOLD,
} from './analysis.js';
import { buildQueue, gradeCard, getProgress, saveProgress, stats } from './trainer.js';
import { loadBook, bookAt, bookExit, pickBookMove, habitReport, openingReport } from './openings.js';
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

function route() {
  if (!S.user) { renderSetup(); return; }
  const m = location.hash.match(/^#g\/(.+)$/);
  if (m) renderGame(decodeURIComponent(m[1]));
  else if (location.hash === '#train') renderTrain();
  else if (location.hash === '#openings') renderOpenings();
  else if (location.hash === '#drill') renderDrill();
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
      <a href="#" id="switch">Switch account</a>
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

    <div class="board-wrap">
      <div class="evalbar"><div id="evalfill"></div></div>
      <div id="board"></div>
    </div>

    <div class="controls">
      <button class="btn nav" id="nav-start">⏮</button>
      <button class="btn nav" id="nav-prev">◀</button>
      <div class="eval-read" id="eval-read">—</div>
      <button class="btn nav" id="nav-next">▶</button>
      <button class="btn nav" id="nav-end">⏭</button>
    </div>

    <div id="graph-wrap"></div>
    <div class="card"><div class="movegrid" id="movegrid"></div></div>
    <div id="analyze-area"></div>
    <div id="coach"></div>`;

  const board = new Board($('#board'));
  board.setFlip(g.myColor === 'b');

  const flaggedByIdx = new Map(); // position index BEFORE the move -> record
  const rebuildFlagMap = () => {
    flaggedByIdx.clear();
    if (!analysis) return;
    for (const r of analysis.records) {
      if (r.severity && r.mover === g.myColor) flaggedByIdx.set(r.i - 1, r);
    }
  };
  rebuildFlagMap();

  const fenAt = (i) => (i === 0 ? startFen : moves[i - 1].after);

  function goTo(newIdx) {
    idx = Math.max(0, Math.min(moves.length, newIdx));
    const rec = flaggedByIdx.get(idx);
    const arrows = [];
    if (rec) {
      arrows.push({ from: rec.played.from, to: rec.played.to, kind: 'played' });
      if (rec.bestUci) arrows.push({ from: rec.bestUci.slice(0, 2), to: rec.bestUci.slice(2, 4), kind: 'best' });
    }
    board.position(fenAt(idx), {
      lastMove: idx > 0 ? [moves[idx - 1].from, moves[idx - 1].to] : null,
      arrows,
    });
    for (const el of document.querySelectorAll('.mv')) el.classList.remove('cur');
    if (idx > 0) $(`.mv[data-i="${idx}"]`)?.classList.add('cur');
    updateEvalUI();
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
        const dot = r && r.severity && r.mover === g.myColor ? `<i class="mdot ${r.severity}"></i>` : '';
        html += `<span class="mv" data-i="${j + 1}">${esc(moves[j].san)}${dot}</span>`;
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
    const flagged = analysis.records
      .filter((r) => r.severity && r.mover === g.myColor)
      .sort((a, b) => b.drop - a.drop);
    const c = analysis.summary.counts;
    coach.innerHTML = `
      <div class="card">
        <h2>Coach review <span class="sub">depth ${analysis.depth}</span></h2>
        <div class="chips">
          <span class="chip blunder">${c.blunder} blunders</span>
          <span class="chip mistake">${c.mistake} mistakes</span>
          <span class="chip inaccuracy">${c.inaccuracy} inaccuracies</span>
          <span class="chip">ACPL ${analysis.summary.acpl}</span>
        </div>
        ${flagged.length ? flagged.map((r) => `
          <div class="flagcard ${r.severity}" data-i="${r.i}">
            <div class="flaghead">
              <b>${esc(r.label)} ${esc(r.san)}</b>
              <span class="sev ${r.severity}">${SEV_LABEL[r.severity]}</span>
            </div>
            <div class="sub">${dropDescription(r)} · eval ${fmtEval(r.before)} → ${fmtEval(r.after)} · ${r.phase}</div>
            <div class="why">${esc(explainMistake(r, analysis.records[r.i] || null))}</div>
          </div>`).join('')
        : `<p class="sub">No moves lost ${THRESHOLD}+ centipawns. Clean game — nice.</p>`}
      </div>`;
    coach.onclick = (e) => {
      const card = e.target.closest('.flagcard');
      if (!card) return;
      goTo(parseInt(card.dataset.i, 10) - 1);
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
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
