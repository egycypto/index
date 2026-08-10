// =========================================================================
// CALL HISTORY — split out of the main script into its own file.
//
// Why: the permanent Call History log keeps growing for as long as the
// page stays open (every BUY/SELL/HOLD call, ever, capped only as a safety
// ceiling). Two problems come from that over time:
//   1. Re-rendering hundreds/thousands of log rows into the DOM on every
//      30s cycle gets slower as the log grows — real work for a panel
//      nobody is looking at.
//   2. Keeping all of that record-keeping code inline in the main script
//      made that file bigger than it needed to be.
//
// This file fixes both: the panel is hidden in the HTML (see the
// `display:none` on its wrapper), and renderCallHistoryPanel() below
// notices that and skips the expensive HTML-building work entirely —
// while callHistoryLog itself keeps recording and persisting normally in
// the background. Flip CALL_HISTORY_PANEL_HIDDEN back to false any time
// you want the panel visible again; no other code needs to change.
//
// Loaded as a plain (non-module) <script> before the main inline script,
// so everything declared here with `var`/`function` is a normal global —
// the main script's references to callHistoryLog, callHistoryStats,
// renderCallHistoryPanel(), etc. resolve to these exact same variables,
// nothing else had to change on that side.
// =========================================================================

var CALL_HISTORY_MAX = 20000; // safety ceiling against unbounded storage growth, not a rolling window
var CALLHIST_PERSIST_KEY = "btcTerminalCallHistoryLog_v1";

var callHistoryLog = []; // most-recent-first, unbounded (up to CALL_HISTORY_MAX): {ts, tsFull, direction, label, price, confidence, outcome, scoredPrice}
var callHistoryStats = {
  buy: {correct:0, total:0},
  sell: {correct:0, total:0}
};

// Panel is hidden by default (see the HTML wrapper's display:none) — this
// flag is what lets renderCallHistoryPanel() skip its own work instead of
// building an ever-larger HTML string every cycle for a div nobody sees.
var CALL_HISTORY_PANEL_HIDDEN = true;

// Renders the permanent Call History panel from callHistoryLog. While
// CALL_HISTORY_PANEL_HIDDEN is true this is nearly a no-op — the log keeps
// collecting and persisting exactly as before, only the DOM work is
// skipped, which is what actually avoids the "flooding" as the log grows
// into the thousands of rows.
function renderCallHistoryPanel(){
  var histArea = document.getElementById("sigHistoryArea");
  if (!histArea) return;
  if (CALL_HISTORY_PANEL_HIDDEN) return;

  // Full log keeps growing forever underneath; the DOM only ever
  // renders the most recent slice for performance.
  var DISPLAY_MAX = 300;
  var histHtml = "";
  var lifeBuy = callHistoryStats.buy, lifeSell = callHistoryStats.sell;
  var lifeTotal = lifeBuy.total + lifeSell.total;
  if (lifeTotal > 0){
    var lifeCorrect = lifeBuy.correct + lifeSell.correct;
    histHtml += "<div class='pred-line' style='margin-bottom:6px;padding-bottom:8px;border-bottom:1px solid var(--line);'><span class='lbl'>Lifetime record</span> — <span class='val'>" +
      lifeCorrect + " / " + lifeTotal + " correct (" + (lifeCorrect/lifeTotal*100).toFixed(1) + "%)</span>" +
      " &nbsp;·&nbsp; Buy " + (lifeBuy.total > 0 ? lifeBuy.correct + "/" + lifeBuy.total + " (" + (lifeBuy.correct/lifeBuy.total*100).toFixed(0) + "%)" : "—") +
      " &nbsp;·&nbsp; Sell " + (lifeSell.total > 0 ? lifeSell.correct + "/" + lifeSell.total + " (" + (lifeSell.correct/lifeSell.total*100).toFixed(0) + "%)" : "—") +
      " &nbsp;·&nbsp; <span style='color:var(--ink-dim);'>" + callHistoryLog.length + " calls logged, saved automatically</span></div>";
  }
  for (var j=0;j<Math.min(callHistoryLog.length, DISPLAY_MAX);j++){
    var h = callHistoryLog[j];
    var hCls = h.direction === "BUY" ? "up-txt" : h.direction === "SELL" ? "down-txt" : "flat-txt";
    var outMark = h.outcome === "correct" ? "✓" : h.outcome === "wrong" ? "✗" : h.outcome === "pending" ? "…" :
      h.outcome === "flat" ? "○ (flat, not scored)" : "—";
    histHtml += "<div class='pred-line'>" + h.ts + " — <span class='" + hCls + "'>" + (h.label || h.direction) + "</span> at " + fmtUsd(h.price) +
      (h.confidence !== null ? " (" + h.confidence.toFixed(1) + "%)" : "") +
      " &nbsp; " + outMark + (h.scoredPrice !== null ? " → " + fmtUsd(h.scoredPrice) : "") + "</div>";
  }
  if (!callHistoryLog.length){
    histArea.innerHTML = "<div class='empty'>No calls yet.</div>";
    return;
  }
  if (callHistoryLog.length > DISPLAY_MAX){
    histHtml += "<div class='pred-line' style='color:var(--ink-dim);'>… " + (callHistoryLog.length - DISPLAY_MAX) + " older calls kept in the full log (" + callHistoryLog.length + " total logged)</div>";
  }
  histArea.innerHTML = histHtml;
}

// Persists callHistoryLog + callHistoryStats to their own localStorage key,
// independent of every other persisted blob — unaffected by hiding the
// panel, so the background collection keeps saving exactly as before.
function saveCallHistoryLog(){
  try {
    localStorage.setItem(CALLHIST_PERSIST_KEY, JSON.stringify({
      callHistoryLog: callHistoryLog,
      callHistoryStats: callHistoryStats
    }));
  } catch(e){ /* storage full or unavailable — just skip this save */ }
}

// Restores callHistoryLog + callHistoryStats from their own localStorage
// key. Safe to call even if nothing was ever saved (log just starts empty).
function loadCallHistoryLog(){
  try {
    var raw = localStorage.getItem(CALLHIST_PERSIST_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (!saved) return;
    callHistoryLog = Array.isArray(saved.callHistoryLog) ? saved.callHistoryLog : [];
    if (saved.callHistoryStats){
      callHistoryStats.buy = saved.callHistoryStats.buy || {correct:0, total:0};
      callHistoryStats.sell = saved.callHistoryStats.sell || {correct:0, total:0};
    }
  } catch(e){ /* storage unavailable or corrupt — permanent call history just starts empty */ }
}
