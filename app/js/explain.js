// Optional written coaching from Claude.
//
// This is the one part of Knight Coach that costs money, so it is opt-in, it
// only ever runs when you press a button, and every explanation is cached
// permanently by position - you never pay twice for the same move.
//
// The API key lives in this device's localStorage and is sent straight to
// api.anthropic.com. It is never committed, never sent anywhere else, and is
// not part of the published site.

import { idbGet, idbPut } from './db.js';

const MODEL = 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const KEY_NAME = 'kc.apiKey';

// Sonnet 5 list price per million tokens. Anthropic ran a lower introductory
// rate until 2026-08-31, so real spend may come in under this estimate.
const USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;

const SYSTEM = `You are a patient chess coach working with a club player rated around 900.
Explain in plain language. If you use a chess term like "fork", "pin", "tempo" or
"outpost", say in the same sentence what it means here. Be concrete about the actual
pieces and squares rather than talking in generalities.
Cover two things: why the move played goes wrong, and what the better move is trying to
achieve - the idea behind it, not just the notation.
Write 3 to 5 sentences of plain prose. No headings, no lists, no markdown, and no
internal or system XML tags.`;

export function getApiKey() {
  return localStorage.getItem(KEY_NAME) || '';
}

export function setApiKey(key) {
  localStorage.setItem(KEY_NAME, key.trim());
}

export function clearApiKey() {
  localStorage.removeItem(KEY_NAME);
}

export function hasApiKey() {
  return !!getApiKey();
}

export async function getSpend() {
  return (await idbGet('kv', 'spend')) || { inputTokens: 0, outputTokens: 0, calls: 0 };
}

export function spendUsd(spend) {
  return spend.inputTokens * USD_PER_INPUT_TOKEN + spend.outputTokens * USD_PER_OUTPUT_TOKEN;
}

async function recordSpend(usage) {
  const spend = await getSpend();
  spend.inputTokens += usage?.input_tokens || 0;
  spend.outputTokens += usage?.output_tokens || 0;
  spend.calls += 1;
  await idbPut('kv', 'spend', spend);
  return spend;
}

// One cache entry per position + move played, so re-reading a game is free.
function cacheKey(rec) {
  return `exp|${rec.fenBefore}|${rec.san}`;
}

export async function cachedExplanation(rec) {
  return (await idbGet('kv', cacheKey(rec))) || null;
}

function buildPrompt({ rec, mechanical, opening, myColor, oppName }) {
  const side = rec.mover === 'w' ? 'White' : 'Black';
  const evalLine = `The evaluation went from ${rec.before / 100} to ${rec.after / 100} pawns (positive favours White).`;
  return [
    `Position before the move, in FEN: ${rec.fenBefore}`,
    `I am playing ${myColor === 'w' ? 'White' : 'Black'} against ${oppName}. Opening: ${opening}.`,
    `${side} to move, and I played ${rec.label} ${rec.san}.`,
    evalLine,
    rec.bestLine ? `The engine preferred: ${rec.bestLine}` : '',
    mechanical ? `An engine-derived note says: ${mechanical}` : '',
    '',
    'Explain what went wrong with my move and what the better move is actually trying to do.',
  ].filter(Boolean).join('\n');
}

/**
 * Ask Claude to explain one move. Returns {text, cached, spend}.
 * Throws with a readable message on auth, rate-limit, or network failure.
 */
export async function explainMove(ctx) {
  const cached = await cachedExplanation(ctx.rec);
  if (cached) return { text: cached, cached: true, spend: await getSpend() };

  const key = getApiKey();
  if (!key) throw new Error('No API key saved.');

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // required for calls made straight from a browser
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        // Deliberately off: a few sentences of explanation does not need
        // reasoning tokens, and thinking is billed as output.
        thinking: { type: 'disabled' },
        system: SYSTEM,
        messages: [{ role: 'user', content: buildPrompt(ctx) }],
      }),
    });
  } catch {
    throw new Error('Could not reach the Claude API. Check your connection.');
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
    if (res.status === 401) throw new Error('That API key was rejected. Check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by the API. Wait a moment and try again.');
    if (res.status === 400 && /credit|balance/i.test(detail)) {
      throw new Error('Your Anthropic account is out of credit.');
    }
    throw new Error(detail || `The API returned ${res.status}.`);
  }

  const data = await res.json();
  const spend = await recordSpend(data.usage);

  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined to answer that one.');
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('The API returned an empty response.');

  await idbPut('kv', cacheKey(ctx.rec), text);
  return { text, cached: false, spend };
}
