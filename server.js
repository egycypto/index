// =============================================================================
// BTC TERMINAL — AGENT BOT SERVER
// -----------------------------------------------------------------------------
// This is a standalone Node.js process. It exists because a static web page
// cannot execute anything while its browser tab is closed — there is no such
// thing as "run in the background" for a plain HTML/JS file. This script
// solves that by moving the bot's actual decision loop OFF the browser and
// onto a server that runs continuously on its own clock (via setInterval,
// the same way the page did, just without a tab needed to host it).
//
// WHAT IT PORTS FROM THE PAGE (faithfully, same thresholds/formulas):
//   - The core "Buy/Sell Zone" signal: rolling 1-hour BTC price range,
//     position-in-range %, neutral band, gap-based confidence.
//   - This tab's own scored hit-rate feeding back into confidence
//     (bsState.buyStats / sellStats — exactly like the page's bsState).
//   - The Agent Bot itself: runAgentBot's entry/exit rules and
//     agentBotAdapt's self-tuning confidence bar — copied logic, not a
//     re-interpretation.
//
// WHAT IT DELIBERATELY DOES NOT PORT (left as browser-only extras):
//   - TradingView / DexTools / Polymarket / order-book / candle / network-
//     traffic voting. Those are heavily tied to the page's live WebSocket
//     tape and DOM rendering, and folding them in here would mean guessing
//     at behavior instead of replicating known logic. The core range signal
//     above is what actually decides BUY/SELL/HOLD, so the bot is fully
//     functional without them — confidence is just slightly less padded
//     than the page's "backed by other engines" bonus.
//
// PERSISTENCE: everything lives in state.json next to this file. It's
// loaded on boot and saved after every cycle, so a server restart (or a
// crash + pm2/systemd auto-restart) picks up exactly where it left off —
// same idea as the page's localStorage, just on disk instead.
//
// HTTP API (see routes below) lets the existing BTC.html page — when
// pointed at this server — show the bot's real, continuously-updated state
// instead of whatever was last seen in that one browser tab, and lets it
// push a new trade amount in without needing the tab to have been open.
// =============================================================================

const http = require("http");

// ---- $2 flat-move neglect band + rolling 30s significant-price log -------
// Mirrors the page's FLAT_BAND_USD / significant-price log exactly (see
// index.html): a price change under $2 is noise, not a real move, so it
// shouldn't decide a win/loss on its own, and it shouldn't get recorded as
// a distinct "change" in the reference log either. Without this, this
// server's Agent Bot was the one place on the whole project still scoring
// every nonzero tick as a decisive win or loss (the page's bots and scoring
// panels already all use this same band) — that inconsistency is fixed
// below by reusing this same constant for both the trade outcome and the
// reference log.
const FLAT_BAND_USD = 2;
const SIG_PRICE_WINDOW_MS = 30000;

// Only records/advances state.priceRef when the new price clears the band
// vs. the last recorded price — so a string of sub-$2 wiggles never counts
// as several "changes" that could cancel out and read as flat over a
// window; only genuine >=$2 moves land in state.priceRefLog, each once.
function recordSignificantPrice(price, nowMs) {
  nowMs = nowMs || Date.now();
  if (typeof price !== "number" || !isFinite(price)) return false;
  if (state.priceRef === null || state.priceRef === undefined) {
    state.priceRef = price;
    state.priceRefLog.push({ t: nowMs, price });
    return true;
  }
  if (Math.abs(price - state.priceRef) < FLAT_BAND_USD) {
    pruneSigPriceLog(nowMs);
    return false;
  }
  state.priceRef = price;
  state.priceRefLog.push({ t: nowMs, price });
  pruneSigPriceLog(nowMs);
  return true;
}

function pruneSigPriceLog(nowMs) {
  nowMs = nowMs || Date.now();
  const cutoff = nowMs - SIG_PRICE_WINDOW_MS;
  state.priceRefLog = state.priceRefLog.filter((s) => s.t >= cutoff);
}
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const STATE_FILE = path.join(__dirname, "state.json");
// Shared, hot-reloaded config the Overseer Bot (see /overseer) is allowed to
// tune directly — bounded, numeric win-rate-adaptation knobs only. Nothing
// else in this file ever writes to this path; the Overseer Bot owns it, this
// process only reads it. If it's missing/corrupt, defaultTuning() below is
// used as-is, so the bot behaves exactly as before the Overseer Bot existed.
const TUNING_FILE = path.join(__dirname, "tuning.json");
const PORT = process.env.PORT || 8787;

// ---- constants copied from the page (same values, same meaning) ----------
const REPORT_MS = 30 * 1000;              // one signal cycle, same cadence as the page
const LEARNING_RESET_MS = 60 * 60 * 1000; // hourly checkpoint window
const SIGNAL_NEUTRAL_BAND = 10;           // +/- range-% around midpoint counts as HOLD
const AGENT_BASE_MIN_CONFIDENCE = 55;
const PRICE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

// ---- win-rate adaptation knobs — defaults match the original hardcoded
// values in agentBotAdapt() exactly. The Overseer Bot may nudge these
// (within its own sane bounds) in tuning.json; it never edits this file.
function defaultTuning() {
  return {
    winRateAdapt: {
      minSamples: 3,
      recentWindow: 6,
      recentBlend: 0.65,
      lifetimeBlend: 0.35,
      roughThreshold: 40,
      belowBreakevenThreshold: 48,
      solidThreshold: 60,
      strongThreshold: 70,
      roughStep: 2,
      belowStep: 1,
      solidStep: -1,
      strongStep: -2,
      floor: 50,
      ceiling: 85,
    },
  };
}

// Re-read on every cycle (cheap — one small JSON file) so a overseer edit
// takes effect within one REPORT_MS, same "just read the file" pattern as
// loadState(). Merged onto defaults field-by-field so a partial or stale
// tuning.json can never crash the bot or leave a knob undefined.
function loadTuning() {
  const d = defaultTuning();
  try {
    const raw = fs.readFileSync(TUNING_FILE, "utf8");
    const saved = JSON.parse(raw);
    if (saved && saved.winRateAdapt) {
      Object.assign(d.winRateAdapt, saved.winRateAdapt);
    }
  } catch (e) {
    // no tuning.json yet, or unreadable/corrupt — defaults are used, same
    // as if the Overseer Bot had never been installed.
  }
  return d;
}

// ---- default state (mirrors agentBot + bsState field-for-field) ----------
function defaultState() {
  return {
    tradeAmountUsd: null,
    minConfidence: AGENT_BASE_MIN_CONFIDENCE,
    position: null,      // {entryPrice, entryTs}
    trades: [],          // most-recent-first, capped at 6, same shape as the page
    wins: 0,
    losses: 0,
    totalPnlPct: 0,
    totalPnlUsd: 0,
    totalPnlBtc: 0,
    hourWins: 0,
    hourLosses: 0,
    hourPnlUsd: 0,
    hourPnlBtc: 0,
    hourSnapshots: [],
    adaptLog: [],
    bsState: {
      pending: null,                          // {direction, price, ts}
      buyStats: { correct: 0, total: 0 },
      sellStats: { correct: 0, total: 0 },
    },
    priceSamples: [],   // rolling 1h of {ts, price}, used to derive low/high
    priceRef: null,      // last price that cleared FLAT_BAND_USD — see recordSignificantPrice
    priceRefLog: [],     // [{t, price}], only entries that cleared the band, pruned to last 30s
    lastPrice: null,
    lastCall: null,     // {ts, direction, confidence, positionPct, gapPct}
    lastLearningReset: Date.now(),
    startedAt: Date.now(),
    lastCycleAt: null,
    lastError: null,
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const saved = JSON.parse(raw);
    // Merge onto defaults so new fields introduced later never crash an
    // older state.json — same defensive pattern the page used for
    // localStorage restores.
    return Object.assign(defaultState(), saved);
  } catch (e) {
    return defaultState();
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save state.json:", e.message);
  }
}

let state = loadState();

// ---- rolling 1h range, same idea as the page's hourBuckets ---------------
function pruneAndGetRange(nowMs) {
  const cutoff = nowMs - LEARNING_RESET_MS;
  state.priceSamples = state.priceSamples.filter((s) => s.ts >= cutoff);
  if (state.priceSamples.length === 0) return null;
  let low = Infinity, high = -Infinity;
  for (const s of state.priceSamples) {
    if (s.price < low) low = s.price;
    if (s.price > high) high = s.price;
  }
  return { low, high };
}

// ---- confidence blend: gap-from-midpoint + this bot's own hit-rate -------
// (subset of the page's computeSignalConfidence — the other-engine terms
// are intentionally omitted, see file header)
function computeConfidence(direction, gapConfidence) {
  const stats = direction === "BUY" ? state.bsState.buyStats : state.bsState.sellStats;
  const ownRate = stats.total > 0 ? (stats.correct / stats.total) * 100 : null;

  let wsum = 1, vsum = gapConfidence;
  if (ownRate !== null) {
    const ownW = Math.min(stats.total / 10, 2.5);
    wsum += ownW;
    vsum += ownRate * ownW;
  }
  return Math.max(5, Math.min(97, vsum / wsum));
}

// ---- Agent Bot entry/exit rules — copied from runAgentBot on the page ----
function runAgentBot(direction, confidence, price, ts) {
  if (price === null || direction === "HOLD") return;
  if (!state.tradeAmountUsd || state.tradeAmountUsd <= 0) return;

  if (!state.position) {
    if (direction === "BUY" && confidence >= state.minConfidence) {
      state.position = { entryPrice: price, entryTs: ts };
    }
    return;
  }

  if (direction === "SELL" && confidence >= state.minConfidence) {
    const entry = state.position;
    const pnlPct = ((price - entry.entryPrice) / entry.entryPrice) * 100;
    // Always the CURRENTLY entered amount, same rule as the page — size
    // follows the box, not a snapshot frozen at entry.
    const amountUsd = state.tradeAmountUsd;
    const pnlUsd = (pnlPct / 100) * amountUsd;
    const pnlBtc = price ? pnlUsd / price : 0;
    const btcQty = amountUsd / entry.entryPrice;
    const pctOfBtc = btcQty * 100;
    // $2 neglect band (see FLAT_BAND_USD above, mirrors the page exactly) —
    // a move this small isn't a real win or loss, just noise around the
    // entry price, so it's scored "flat" and left out of wins/losses.
    const outcome = (Math.abs(price - entry.entryPrice) <= FLAT_BAND_USD) ? "flat" : (pnlPct > 0 ? "win" : "loss");

    if (outcome === "win") { state.wins += 1; state.hourWins += 1; }
    else if (outcome === "loss") { state.losses += 1; state.hourLosses += 1; }

    state.totalPnlPct += pnlPct;
    state.totalPnlUsd += pnlUsd;
    state.totalPnlBtc += pnlBtc;
    state.hourPnlUsd += pnlUsd;
    state.hourPnlBtc += pnlBtc;

    state.trades.unshift({
      entryTs: entry.entryTs, exitTs: ts,
      entryPrice: entry.entryPrice, exitPrice: price,
      pnlPct, pnlUsd, pnlBtc, amountUsd, btcQty, pctOfBtc, outcome,
    });
    if (state.trades.length > 6) state.trades.length = 6;

    state.position = null;
    agentBotAdapt();
  }
}

// ---- self-tuning confidence bar — copied from agentBotAdapt on the page --
// All thresholds/steps/bounds below come from tuning.json (via loadTuning()),
// falling back to the exact original hardcoded values — see defaultTuning().
function agentBotAdapt() {
  const cfg = loadTuning().winRateAdapt;
  const total = state.wins + state.losses;
  if (total < cfg.minSamples) return;

  const lifetimeRate = (state.wins / total) * 100;
  const recent = state.trades.slice(0, cfg.recentWindow);
  const recentWins = recent.filter((t) => t.outcome === "win").length;
  const recentLosses = recent.filter((t) => t.outcome === "loss").length;
  const recentTotal = recentWins + recentLosses;
  const recentRate = recentTotal > 0 ? (recentWins / recentTotal) * 100 : lifetimeRate;
  const blendedRate = recentTotal >= 4 ? recentRate * cfg.recentBlend + lifetimeRate * cfg.lifetimeBlend : lifetimeRate;

  const before = state.minConfidence;
  let reason = null;
  if (blendedRate < cfg.roughThreshold) {
    state.minConfidence = Math.min(cfg.ceiling, state.minConfidence + cfg.roughStep);
    reason = `win rate ${blendedRate.toFixed(0)}% is rough — raising the confidence bar`;
  } else if (blendedRate < cfg.belowBreakevenThreshold) {
    state.minConfidence = Math.min(cfg.ceiling, state.minConfidence + cfg.belowStep);
    reason = `win rate ${blendedRate.toFixed(0)}% is below break-even — nudging the bar up`;
  } else if (blendedRate > cfg.strongThreshold) {
    state.minConfidence = Math.max(cfg.floor, state.minConfidence + cfg.strongStep);
    reason = `win rate ${blendedRate.toFixed(0)}% is strong — loosening the confidence bar`;
  } else if (blendedRate > cfg.solidThreshold) {
    state.minConfidence = Math.max(cfg.floor, state.minConfidence + cfg.solidStep);
    reason = `win rate ${blendedRate.toFixed(0)}% is solid — nudging the bar down`;
  }

  if (reason && state.minConfidence !== before) {
    state.adaptLog.unshift({
      ts: new Date().toISOString(), reason,
      from: before, to: state.minConfidence,
    });
    if (state.adaptLog.length > 8) state.adaptLog.length = 8;
  }
}

// ---- hourly checkpoint — copied from agentBotHourlySnapshot --------------
function maybeHourlyCheckpoint(nowMs) {
  if (nowMs - state.lastLearningReset < LEARNING_RESET_MS) return;
  const total = state.hourWins + state.hourLosses;
  state.hourSnapshots.unshift({
    ts: new Date().toISOString(),
    wins: state.hourWins, losses: state.hourLosses,
    winRate: total > 0 ? (state.hourWins / total) * 100 : null,
    pnlUsd: state.hourPnlUsd, pnlBtc: state.hourPnlBtc,
  });
  if (state.hourSnapshots.length > 24) state.hourSnapshots.length = 24;
  state.hourWins = 0; state.hourLosses = 0;
  state.hourPnlUsd = 0; state.hourPnlBtc = 0;
  state.lastLearningReset = nowMs;
}

// ---- one full signal + trading cycle, same cadence as the page's ---------
async function runCycle() {
  const nowMs = Date.now();
  const ts = new Date(nowMs).toISOString();
  try {
    const res = await fetch(PRICE_URL);
    if (!res.ok) throw new Error("Binance price fetch failed: " + res.status);
    const data = await res.json();
    const price = parseFloat(data.price);
    if (!isFinite(price)) throw new Error("Bad price payload");

    state.priceSamples.push({ ts: nowMs, price });
    state.lastPrice = price;
    recordSignificantPrice(price, nowMs);

    maybeHourlyCheckpoint(nowMs);

    const range = pruneAndGetRange(nowMs);
    if (!range || range.high <= range.low) {
      state.lastCall = null;
      state.lastError = null;
      state.lastCycleAt = ts;
      saveState();
      return;
    }

    const positionPct = ((price - range.low) / (range.high - range.low)) * 100;
    const midDist = Math.abs(positionPct - 50);
    const gapPct = midDist * 2;
    const gapConfidence = 50 + gapPct * 0.45;

    let direction;
    if (midDist <= SIGNAL_NEUTRAL_BAND) direction = "HOLD";
    else direction = positionPct < 50 ? "BUY" : "SELL";

    // score whatever call was pending from the previous cycle
    if (state.bsState.pending) {
      const p = state.bsState.pending;
      const wasCorrect = p.direction === "BUY" ? price > p.price : price < p.price;
      const stats = p.direction === "BUY" ? state.bsState.buyStats : state.bsState.sellStats;
      stats.total += 1;
      if (wasCorrect) stats.correct += 1;
    }

    const confidence = direction !== "HOLD" ? computeConfidence(direction, gapConfidence) : null;

    state.lastCall = { ts, direction, confidence, positionPct, gapPct, low: range.low, high: range.high };

    if (direction !== "HOLD") {
      state.bsState.pending = { direction, price, ts };
      runAgentBot(direction, confidence, price, ts);
    } else {
      state.bsState.pending = null;
    }

    state.lastError = null;
    state.lastCycleAt = ts;
    saveState();
  } catch (e) {
    state.lastError = e.message;
    state.lastCycleAt = ts;
    saveState();
    console.error("[cycle error]", e.message);
  }
}

// ---- HTTP API --------------------------------------------------------------
// Plain Node `http` server — zero external dependencies, so this runs
// anywhere with just `node server.js`, no `npm install` required.
function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    // Wide-open CORS so the page can poll this from any host it's served
    // from (e.g. GitHub Pages talking to a small VPS running this script).
    // Tighten this to your actual page's origin once you know it.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, state);
  }

  if (req.method === "GET" && url.pathname === "/api/tuning") {
    return sendJson(res, 200, loadTuning());
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
      lastCycleAt: state.lastCycleAt,
      lastError: state.lastError,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/amount") {
    try {
      const body = await readJsonBody(req);
      const val = parseFloat(body.amount);
      if (!isFinite(val) || val <= 0) {
        return sendJson(res, 400, { error: "amount must be a number > 0" });
      }
      state.tradeAmountUsd = val;
      saveState();
      return sendJson(res, 200, { ok: true, tradeAmountUsd: state.tradeAmountUsd });
    } catch (e) {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Agent Bot server listening on :${PORT}`);
  console.log(`State file: ${STATE_FILE}`);
});

// kick off immediately, then every REPORT_MS — same cadence as the page
runCycle();
setInterval(runCycle, REPORT_MS);
