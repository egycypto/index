// =============================================================================
// Overseer Bot — supervises every other bot in this project.
// -----------------------------------------------------------------------------
// WHAT IT WATCHES:
//   - server.js's Agent Bot: polls its GET /api/state directly.
//   - The browser's four bots (Agent Bot, Shadow Bot, Fusion Bot, Sentinel
//     Bot) plus the permanent Call History log: index.html pushes a
//     summary snapshot to this bot's POST /ingest every OVERSEER_SYNC_MS
//     (see the "OVERSEER EXPORT" block near the end of its inline script).
//     This process never reaches INTO a browser tab — it can only see what
//     that tab chooses to send it, and only summary stats, never raw
//     private state.
//
// WHAT IT DOES WITH WHAT IT SEES (every ANALYSIS_INTERVAL_MS):
//   1. Runs the shared rule engine (see rules.js) against every bot's
//      current win/loss record, its adapt-log history, and (where
//      available) confidence-vs-outcome pairs.
//   2. Writes a full report (findings + the raw numbers behind them) to
//      reports/<timestamp>.md, and appends one line to overseer.log.
//   3. For findings marked low-risk/auto-applicable (see AUTO_APPLY below):
//      nudges tuning.json — a small, bounded, numeric config file that
//      server.js and index.html already read (see the patches to both) —
//      and logs exactly what changed and why to tuning-changes.log. This
//      bot NEVER edits server.js, index.html, or call-history.js directly.
//   4. For findings that point at an actual logic problem (a bar that's
//      maxed out and still losing, confidence scores that don't track real
//      accuracy, etc.) it writes a plain-English proposal — what it found,
//      why, and a concrete suggested code change — to
//      proposals/<timestamp>-<bot>-<rule>.md for YOU to review and apply.
//      It never touches source code for these.
//
// This file has zero npm dependencies (plain http/fs, same style as
// server.js) so `node overseer.js` just works.
// =============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { normalizeBot, analyzeBot, ruleConfidenceMiscalibration, ruleRegimeWeightDrift } = require("./rules");

// ---- configuration ----------------------------------------------------------
// Point this at the folder containing server.js/state.json/tuning.json.
// Default assumes the layout this was shipped in: project/server.js,
// project/overseer/overseer.js (this file).
const PROJECT_DIR = process.env.OVERSEER_PROJECT_DIR || path.join(__dirname, "..");
const TUNING_FILE = path.join(PROJECT_DIR, "tuning.json");
const SERVER_STATE_URL = process.env.OVERSEER_SERVER_URL || "http://localhost:8787/api/state";
const PORT = process.env.OVERSEER_PORT || 8788;
const ANALYSIS_INTERVAL_MS = Number(process.env.OVERSEER_ANALYSIS_INTERVAL_MS || 5 * 60 * 1000); // 5 min
const REPORTS_DIR = path.join(__dirname, "reports");
const PROPOSALS_DIR = path.join(__dirname, "proposals");
const OVERSEER_LOG = path.join(__dirname, "overseer.log");
const TUNING_CHANGES_LOG = path.join(__dirname, "tuning-changes.log");

for (const d of [REPORTS_DIR, PROPOSALS_DIR]) fs.mkdirSync(d, { recursive: true });

// Which rules this bot is allowed to act on by itself, and the HARD outer
// bounds it will never push tuning.json past no matter what a rule asks
// for — this is the real safety backstop, independent of anything rules.js
// computes. Widen these deliberately and separately if you ever want to;
// this bot never widens its own leash.
const AUTO_APPLY_RULES = new Set(["STUCK_AT_CEILING_LOSING", "OSCILLATING_NO_PROGRESS", "DEGRADING_RECENT"]);
const HARD_BOUNDS = {
  ceiling: { min: 50, max: 92 },
  floor: { min: 30, max: 60 },
  recentBlend: { min: 0.3, max: 0.85 },
  lifetimeBlend: { min: 0.15, max: 0.7 },
  roughStep: { min: 0.5, max: 4 },
  belowStep: { min: 0.5, max: 3 },
};

// ---- default tuning (mirrors defaultTuning() in server.js) -----------------
function defaultTuning() {
  return {
    version: 1,
    updatedAt: null,
    winRateAdapt: {
      minSamples: 3, recentWindow: 6, recentBlend: 0.65, lifetimeBlend: 0.35,
      roughThreshold: 40, belowBreakevenThreshold: 48, solidThreshold: 60, strongThreshold: 70,
      roughStep: 2, belowStep: 1, solidStep: -1, strongStep: -2, floor: 50, ceiling: 85,
    },
    autoApplyLog: [], // most-recent-first: {ts, bot, rule, field, from, to, reason}
  };
}

function loadTuning() {
  try {
    const raw = fs.readFileSync(TUNING_FILE, "utf8");
    const saved = JSON.parse(raw);
    const d = defaultTuning();
    if (saved.winRateAdapt) Object.assign(d.winRateAdapt, saved.winRateAdapt);
    if (Array.isArray(saved.autoApplyLog)) d.autoApplyLog = saved.autoApplyLog;
    return d;
  } catch (e) {
    return defaultTuning();
  }
}

function saveTuning(t) {
  t.updatedAt = new Date().toISOString();
  fs.writeFileSync(TUNING_FILE, JSON.stringify(t, null, 2));
}

function clamp(field, value) {
  const b = HARD_BOUNDS[field];
  if (!b) return value;
  return Math.max(b.min, Math.min(b.max, value));
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(OVERSEER_LOG, stamped + "\n");
}

// ---- state this process holds in memory -------------------------------------
let latestBrowserSnapshot = null; // last POST /ingest body
let latestBrowserSnapshotAt = null;
let latestReport = null; // last analysis result, served at GET /report

// Tracks, per bot, how many consecutive analysis cycles its bar has sat
// exactly at its floor while total scored calls hasn't grown at all — this
// is what feeds ruleStalledAtFloor (rules.js). Deliberately kept here
// rather than in rules.js: rules.js stays pure/stateless (one snapshot in,
// findings out), and this needs memory across cycles to tell "just eased
// down to the floor" apart from "been pinned here for hours." In-memory
// only (resets if the Overseer restarts) — a few cycles of missed detection
// after a restart is a fine tradeoff for not needing to persist this.
const stallTrackers = new Map(); // botLabel -> { lastTotal, cyclesAtFloor }
function trackStagnantAtFloor(botLabel, bar, barFloor, total) {
  const atFloor = typeof bar === "number" && typeof barFloor === "number" && bar <= barFloor + 0.01;
  const prev = stallTrackers.get(botLabel) || { lastTotal: null, cyclesAtFloor: 0 };
  let cyclesAtFloor;
  if (!atFloor) {
    cyclesAtFloor = 0;
  } else if (prev.lastTotal === total) {
    cyclesAtFloor = prev.cyclesAtFloor + 1;
  } else {
    cyclesAtFloor = 1; // at the floor, but scoring did move since last cycle — reset the streak
  }
  stallTrackers.set(botLabel, { lastTotal: total, cyclesAtFloor });
  return cyclesAtFloor;
}

// ---- fetching server.js's state ---------------------------------------------
function fetchServerState() {
  return new Promise((resolve) => {
    const req = http.get(SERVER_STATE_URL, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null)); // server.js not running — fine, just skip that section
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

// ---- one full analysis cycle -------------------------------------------------
async function runAnalysis() {
  const serverState = await fetchServerState();
  const browser = latestBrowserSnapshot ? latestBrowserSnapshot.bots : null;
  const browserStale = latestBrowserSnapshotAt && Date.now() - latestBrowserSnapshotAt > ANALYSIS_INTERVAL_MS * 3;

  const allFindings = []; // {bot, ...finding}
  const proposals = [];
  const summaries = [];

  function pushFindings(botLabel, m, extraCalibrationCalls, regimeMemory) {
    summaries.push(m);
    for (const f of analyzeBot(m)) {
      allFindings.push({ bot: botLabel, ...f });
      if (f.alsoPropose) proposals.push({ bot: botLabel, rule: f.rule, ...f.alsoPropose });
    }
    if (extraCalibrationCalls) {
      const cf = ruleConfidenceMiscalibration(botLabel, extraCalibrationCalls);
      if (cf) {
        allFindings.push({ bot: botLabel, ...cf });
        if (cf.alsoPropose) proposals.push({ bot: botLabel, rule: cf.rule, ...cf.alsoPropose });
      }
    }
    // Regime-memory drift check (see ruleRegimeWeightDrift in rules.js) —
    // only runs for bots that export a regimeMemory summary (Sentinel Bot,
    // Correlation Bot; see summarizeRegimeMemory in buildOverseerSnapshot).
    if (regimeMemory && regimeMemory.summary) {
      const rf = ruleRegimeWeightDrift(botLabel, regimeMemory.summary, regimeMemory.learnParams);
      if (rf) {
        allFindings.push({ bot: botLabel, ...rf });
        if (rf.alsoPropose) proposals.push({ bot: botLabel, rule: rf.rule, ...rf.alsoPropose });
      }
    }
  }

  // --- server.js Agent Bot ---
  if (serverState) {
    const outcomes = (serverState.trades || []).map((t) => t.outcome);
    const total0 = (serverState.wins || 0) + (serverState.losses || 0);
    const m = normalizeBot("Agent Bot (server.js)", {
      wins: serverState.wins, losses: serverState.losses, adaptLog: serverState.adaptLog,
      bar: serverState.minConfidence, barFloor: 50, barCeiling: 85, recentOutcomes: outcomes,
      stagnantAtFloorCycles: trackStagnantAtFloor("Agent Bot (server.js)", serverState.minConfidence, 50, total0),
    });
    pushFindings("Agent Bot (server.js)", m);
  } else {
    log(`server.js unreachable at ${SERVER_STATE_URL} — skipping its Agent Bot this cycle`);
  }

  // --- browser bots (only if we've heard from the page recently) ---
  if (browser && !browserStale) {
    if (browser.agentBot_browser) {
      const b = browser.agentBot_browser;
      pushFindings("Agent Bot (browser)", normalizeBot("Agent Bot (browser)", {
        wins: b.wins, losses: b.losses, adaptLog: b.adaptLog, bar: b.minConfidence,
        barFloor: 50, barCeiling: 85, recentOutcomes: b.recentOutcomes,
        stagnantAtFloorCycles: trackStagnantAtFloor("Agent Bot (browser)", b.minConfidence, 50, (b.wins || 0) + (b.losses || 0)),
      }));
    }
    if (browser.shadowBot) {
      const b = browser.shadowBot;
      pushFindings("Shadow Bot", normalizeBot("Shadow Bot", {
        wins: b.wins, losses: b.losses, adaptLog: b.adaptLog, bar: b.minConfidence,
        barFloor: 50, barCeiling: 85, recentOutcomes: b.recentOutcomes,
        stagnantAtFloorCycles: trackStagnantAtFloor("Shadow Bot", b.minConfidence, 50, (b.wins || 0) + (b.losses || 0)),
      }));
    }
    if (browser.fusionBot) {
      const b = browser.fusionBot;
      // Fusion has no single bar (it's a weight per engine) — win-rate rules
      // that need `bar` just won't fire; only confidence calibration applies.
      pushFindings("Fusion Bot", normalizeBot("Fusion Bot", {
        wins: b.wins, losses: b.losses, adaptLog: b.adaptLog, bar: null,
        recentOutcomes: (b.recentCalls || []).map((c) => c.outcome),
      }), b.recentCalls);
    }
    if (browser.sentinelBot) {
      const b = browser.sentinelBot;
      pushFindings("Sentinel Bot", normalizeBot("Sentinel Bot", {
        wins: b.wins, losses: b.losses, adaptLog: b.adaptLog, bar: b.confThreshold,
        // Real bounds from index.html's SENTINEL_MIN_THRESHOLD/MAX_THRESHOLD (50/75),
        // not the old placeholder 30/85 — with the wrong ceiling, confThreshold could
        // never be judged "at ceiling" (it physically can't exceed 75), so
        // STUCK_AT_CEILING_LOSING could never fire for this bot. Also now reads real
        // recent outcomes (sentinelBot.recentScored, exported below) instead of an
        // always-empty array, so DEGRADING_RECENT can fire too.
        barFloor: 50, barCeiling: 75, recentOutcomes: b.recentOutcomes || [],
        stagnantAtFloorCycles: trackStagnantAtFloor("Sentinel Bot", b.confThreshold, 50, (b.wins || 0) + (b.losses || 0)),
      }), b.recentScoredCalls, // confidence+outcome pairs — feeds CONFIDENCE_MISCALIBRATION, same as Fusion Bot
      b.regimeMemory ? { summary: b.regimeMemory, learnParams: b.learnParams } : null);
    }
    // Correlation Bot: now exported the same way every other bot is (see
    // the OVERSEER EXPORT comment above buildOverseerSnapshot in
    // index.html) — was previously only surfaced indirectly via
    // learningExchange.correlationLearnParams, so none of the rule engine
    // could ever run against it. Same treatment as Sentinel Bot, including
    // the same 50/75 real confThreshold bounds (CORR_MIN_THRESHOLD/
    // CORR_MAX_THRESHOLD in index.html) and its own regime-memory check.
    if (browser.corrBot) {
      const b = browser.corrBot;
      pushFindings("Correlation Bot", normalizeBot("Correlation Bot", {
        wins: b.wins, losses: b.losses, adaptLog: b.adaptLog, bar: b.confThreshold,
        barFloor: 50, barCeiling: 75, recentOutcomes: b.recentOutcomes || [],
        stagnantAtFloorCycles: trackStagnantAtFloor("Correlation Bot", b.confThreshold, 50, (b.wins || 0) + (b.losses || 0)),
      }), b.recentScoredCalls,
      b.regimeMemory ? { summary: b.regimeMemory, learnParams: b.learnParams } : null);
    }
    if (browser.callHistory) {
      const ch = browser.callHistory;
      const buyM = normalizeBot("Call History — BUY calls", { wins: ch.buy.correct, losses: ch.buy.total - ch.buy.correct, adaptLog: [], bar: null, recentOutcomes: [] });
      const sellM = normalizeBot("Call History — SELL calls", { wins: ch.sell.correct, losses: ch.sell.total - ch.sell.correct, adaptLog: [], bar: null, recentOutcomes: [] });
      summaries.push(buyM, sellM);
    }
  } else if (browserStale) {
    log(`no browser snapshot in over ${Math.round((ANALYSIS_INTERVAL_MS * 3) / 60000)} min — page probably closed, skipping browser bots this cycle`);
  } else {
    log(`no browser snapshot received yet — open the page (index.html) to start feeding it browser-bot data`);
  }

  // --- auto-apply low-risk findings, bounded, always logged ---
  const tuning = loadTuning();
  const appliedThisCycle = [];
  for (const f of allFindings) {
    if (!f.autoApplicable || !f.patch || !AUTO_APPLY_RULES.has(f.rule)) continue;
    const applyOne = (field, delta) => {
      if (typeof tuning.winRateAdapt[field] !== "number") return null;
      const before = tuning.winRateAdapt[field];
      const after = clamp(field, Math.round((before + delta) * 100) / 100);
      if (after === before) return null; // already at its hard bound — nothing to do
      tuning.winRateAdapt[field] = after;
      return { field, before, after };
    };
    const c1 = applyOne(f.patch.field, f.patch.delta);
    const c2 = f.patch.alsoField ? applyOne(f.patch.alsoField, f.patch.alsoDelta) : null;
    for (const c of [c1, c2]) {
      if (!c) continue;
      const entry = { ts: new Date().toISOString(), bot: f.bot, rule: f.rule, field: c.field, from: c.before, to: c.after, reason: f.patch.reason };
      tuning.autoApplyLog.unshift(entry);
      appliedThisCycle.push(entry);
      fs.appendFileSync(TUNING_CHANGES_LOG, JSON.stringify(entry) + "\n");
      log(`AUTO-APPLIED: ${f.bot} / ${f.rule} — ${c.field} ${c.before} → ${c.after} (${f.patch.reason})`);
    }
  }
  if (tuning.autoApplyLog.length > 50) tuning.autoApplyLog.length = 50;
  if (appliedThisCycle.length) saveTuning(tuning);

  // --- write proposals for anything logic-level ---
  for (const p of proposals) {
    const fname = `${Date.now()}-${slug(p.bot)}-${slug(p.rule)}.md`;
    const body = `# Proposal: ${p.title}\n\n` +
      `**Bot:** ${p.bot}  \n**Rule:** ${p.rule}  \n**Generated:** ${new Date().toISOString()}\n\n` +
      `## Why\n\n${p.body}\n\n` +
      `## Status\n\nNot applied. This file is a suggestion for human review — the Overseer Bot only auto-applies bounded numeric tuning (see tuning-changes.log), never logic or code changes.\n`;
    fs.writeFileSync(path.join(PROPOSALS_DIR, fname), body);
    log(`PROPOSAL written: ${fname}`);
  }

  // --- write the full report ---
  const report = { ts: new Date().toISOString(), summaries, findings: allFindings, appliedThisCycle, proposalsWritten: proposals.length };
  latestReport = report;
  fs.writeFileSync(path.join(REPORTS_DIR, `${Date.now()}.md`), renderReportMarkdown(report));
  log(`analysis cycle complete — ${allFindings.length} findings, ${appliedThisCycle.length} auto-applied, ${proposals.length} proposal(s) written`);
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }

function renderReportMarkdown(report) {
  let md = `# Overseer report — ${report.ts}\n\n`;
  md += `## Bot summaries\n\n`;
  for (const m of report.summaries) {
    md += `- **${m.name}**: ${m.total} scored calls`;
    if (m.lifetimeRate !== null) md += `, lifetime ${m.lifetimeRate.toFixed(1)}%`;
    if (m.recentRate !== null) md += `, recent ${m.recentRate.toFixed(1)}% (n=${m.recentTotal})`;
    if (m.bar !== null) md += `, bar=${m.bar}`;
    md += `\n`;
  }
  md += `\n## Findings\n\n`;
  if (!report.findings.length) md += "None.\n";
  for (const f of report.findings) {
    md += `- **[${f.severity.toUpperCase()}] ${f.bot} — ${f.rule}**: ${f.message}\n`;
  }
  if (report.appliedThisCycle.length) {
    md += `\n## Auto-applied this cycle\n\n`;
    for (const a of report.appliedThisCycle) md += `- ${a.bot} / ${a.rule}: \`${a.field}\` ${a.from} → ${a.to} — ${a.reason}\n`;
  }
  if (report.proposalsWritten) md += `\n## Proposals\n\n${report.proposalsWritten} written to /proposals for review.\n`;
  return md;
}

// ---- HTTP API ----------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2e6) { req.destroy(); reject(new Error("body too large")); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
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

  if (req.method === "GET" && url.pathname === "/tuning") {
    return sendJson(res, 200, loadTuning());
  }
  if (req.method === "POST" && url.pathname === "/ingest") {
    try {
      latestBrowserSnapshot = await readJsonBody(req);
      latestBrowserSnapshotAt = Date.now();
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }
  }
  if (req.method === "GET" && url.pathname === "/report") {
    return sendJson(res, 200, latestReport || { message: "no analysis cycle has run yet" });
  }
  if (req.method === "POST" && url.pathname === "/analyze-now") {
    await runAnalysis();
    return sendJson(res, 200, latestReport);
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, lastBrowserSnapshotAt: latestBrowserSnapshotAt, hasReport: !!latestReport });
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Overseer listening on :${PORT}`);
  console.log(`Watching server.js at ${SERVER_STATE_URL}`);
  console.log(`Tuning file: ${TUNING_FILE}`);
  console.log(`Reports: ${REPORTS_DIR}   Proposals: ${PROPOSALS_DIR}`);
});

runAnalysis();
setInterval(runAnalysis, ANALYSIS_INTERVAL_MS);
