// =============================================================================
// OVERSEER BOT — RULE ENGINE
// -----------------------------------------------------------------------------
// Pure functions only (no fs/http/timers here) so the logic is easy to read,
// test, and reason about on its own. overseer.js calls into this file once
// per analysis cycle with a normalized view of every bot it knows about.
//
// Every bot this project has (Agent Bot on the server, Agent Bot / Shadow
// Bot / Fusion Bot / Sentinel Bot in the browser) tunes itself the same
// general way: track wins/losses, compare a recent window against the
// lifetime rate, and nudge some bounded numeric bar up or down. That shared
// shape is what makes ONE generic rule set possible instead of bespoke code
// per bot. Fusion's per-engine weights and Sentinel's skew/call-agreement
// buckets are a different shape (a vector of weights instead of one bar) —
// they're monitored and get calibration checks, but their own internal
// tuning formula is left alone; findings there always come out as PROPOSALs,
// never auto-applied (see overseer.js AUTO_APPLY_RULES).
// =============================================================================

// ---- normalization ---------------------------------------------------------

// Turns whatever shape a bot's stats arrive in into one common summary.
// `bar` is whatever bounded numeric knob this bot self-tunes (minConfidence,
// confThreshold, ...) or null if it doesn't have one in this simple form.
function normalizeBot(name, { wins, losses, adaptLog, bar, barFloor, barCeiling, recentOutcomes, minSamplesForVerdict, stagnantAtFloorCycles }) {
  const total = (wins || 0) + (losses || 0);
  const lifetimeRate = total > 0 ? (wins / total) * 100 : null;

  const recent = (recentOutcomes || []).slice(0, 8);
  const recentWins = recent.filter((o) => o === "win").length;
  const recentLosses = recent.filter((o) => o === "loss").length;
  const recentTotal = recentWins + recentLosses;
  const recentRate = recentTotal > 0 ? (recentWins / recentTotal) * 100 : null;

  const log = (adaptLog || []).slice(0, 8);
  // sign of each adapt step: bar going up (pickier) = +1, down (looser) = -1
  const signs = log
    .map((e) => (typeof e.from === "number" && typeof e.to === "number" ? Math.sign(e.to - e.from) : 0))
    .filter((s) => s !== 0);
  let flips = 0;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) flips++;

  return {
    name,
    total,
    lifetimeRate,
    recentTotal,
    recentRate,
    bar: typeof bar === "number" ? bar : null,
    barFloor: typeof barFloor === "number" ? barFloor : null,
    barCeiling: typeof barCeiling === "number" ? barCeiling : null,
    atFloor: typeof bar === "number" && typeof barFloor === "number" && bar <= barFloor + 0.01,
    atCeiling: typeof bar === "number" && typeof barCeiling === "number" && bar >= barCeiling - 0.01,
    adaptEvents: log.length,
    adaptFlips: flips,
    minSamplesForVerdict: minSamplesForVerdict || 15,
    // How many consecutive analysis cycles this bot's bar has sat exactly at
    // its floor while `total` hasn't grown at all — caller (overseer.js)
    // tracks this across cycles and passes it in, since a single snapshot
    // can't tell "just eased down to the floor this cycle" apart from
    // "pinned here for hours with nothing clearing it."
    stagnantAtFloorCycles: stagnantAtFloorCycles || 0,
  };
}

// ---- rule engine ------------------------------------------------------------
// Each rule returns null (doesn't apply) or a finding:
//   { rule, severity: "info"|"watch"|"action", message, autoApplicable, patch? }
// `patch` (only on autoApplicable findings) is a small, bounded delta to
// apply to winRateAdaptCfg — overseer.js decides whether to actually write
// it, and always clamps it through its own hard safety bounds regardless.

function ruleInsufficientData(m) {
  if (m.total >= m.minSamplesForVerdict) return null;
  return {
    rule: "INSUFFICIENT_DATA",
    severity: "info",
    message: `${m.name}: only ${m.total} scored calls so far — no verdict yet, needs ${m.minSamplesForVerdict}+.`,
    autoApplicable: false,
  };
}

function ruleStuckAtCeilingLosing(m) {
  if (!m.atCeiling || m.lifetimeRate === null || m.total < m.minSamplesForVerdict) return null;
  if (m.lifetimeRate >= 45) return null;
  return {
    rule: "STUCK_AT_CEILING_LOSING",
    severity: "action",
    message: `${m.name}: confidence bar is already maxed at its ceiling (${m.bar}) and lifetime win rate is still only ${m.lifetimeRate.toFixed(0)}% over ${m.total} calls. Bounded step-tuning has run out of room to help further.`,
    autoApplicable: true,
    patch: { field: "ceiling", delta: +5, reason: "give the bar a bit more room to tighten further" },
    alsoPropose: {
      title: `${m.name}: consider a logic change, not just a tighter bar`,
      body:
        `The confidence bar alone can't fix a bot that's still losing at its strictest setting — that's a ` +
        `signal-quality or entry-logic problem, not a threshold problem. Worth considering:\n` +
        `  - a cool-down window after N consecutive losses (pause new entries for a while)\n` +
        `  - a regime filter (skip trading when recent volatility/range is unusually thin)\n` +
        `  - re-checking whether the underlying signal this bot acts on is itself well-calibrated ` +
        `(see any CONFIDENCE_MISCALIBRATION findings in this same report)`,
    },
  };
}

function ruleOscillatingNoProgress(m) {
  if (m.adaptEvents < 5 || m.lifetimeRate === null || m.total < m.minSamplesForVerdict) return null;
  if (m.adaptFlips < 3) return null;
  return {
    rule: "OSCILLATING_NO_PROGRESS",
    severity: "action",
    message: `${m.name}: the bar has flipped direction ${m.adaptFlips} times across its last ${m.adaptEvents} adjustments without lifetime win rate clearing 55% (currently ${m.lifetimeRate.toFixed(0)}%) — it's thrashing rather than converging.`,
    autoApplicable: true,
    patch: { field: "lifetimeBlend", delta: +0.05, alsoField: "recentBlend", alsoDelta: -0.05, reason: "weight the stable lifetime rate more than the noisy recent window, to reduce thrashing" },
  };
}

function ruleDegradingRecent(m) {
  if (m.lifetimeRate === null || m.recentRate === null || m.recentTotal < 6) return null;
  if (m.recentRate >= m.lifetimeRate - 12) return null;
  return {
    rule: "DEGRADING_RECENT",
    severity: "watch",
    message: `${m.name}: recent win rate (${m.recentRate.toFixed(0)}% over last ${m.recentTotal}) is running well below its lifetime rate (${m.lifetimeRate.toFixed(0)}%) — something about current conditions may not fit its learned pattern.`,
    autoApplicable: true,
    patch: { field: "roughStep", delta: +0.5, alsoField: "belowStep", alsoDelta: +0.5, reason: "react a little faster to a live losing streak" },
  };
}

// A bar that's been eased all the way down to its floor is normal and
// healthy on its own — the floor exists so a bot can loosen up when it's
// stalling. What's NOT healthy is sitting pinned at that floor, cycle after
// cycle, with total scored calls not moving at all: it means whatever
// gates a call into the win/loss record (e.g. Sentinel's highConf check)
// still isn't passing even at the loosest setting the bar is allowed to
// take, and — unlike STUCK_AT_CEILING_LOSING — there's no further numeric
// knob left to turn. That's always a logic problem (something upstream of
// the bar, like a prediction that never clears it), never a threshold
// problem, so this is always a PROPOSAL, never auto-applied.
function ruleStalledAtFloor(m) {
  if (!m.atFloor || m.stagnantAtFloorCycles < 3) return null;
  return {
    rule: "STALLED_AT_FLOOR",
    severity: "action",
    message: `${m.name}: confidence bar has been pinned at its floor (${m.bar}) for ${m.stagnantAtFloorCycles} consecutive cycles with no new scored calls (still ${m.total} total, ${m.recentTotal} in the recent window) — the bar has nowhere lower to go, so if nothing is clearing it the win/loss record isn't just slow, it's stuck for good.`,
    autoApplicable: false,
    alsoPropose: {
      title: `${m.name}: stalled at its confidence floor with no way to unstick`,
      body:
        `The bar has been sitting at its floor for ${m.stagnantAtFloorCycles} straight analysis cycles and nothing has scored ` +
        `in that time — easing the bar further isn't possible (it's already at the loosest the design allows), so whatever ` +
        `decides a call is confident enough to count isn't clearing that bar even here. That points at the gate itself, not ` +
        `the threshold: something upstream (the prediction feeding the confidence read, or the read itself) may be producing ` +
        `low-confidence output for an extended stretch, or the gate condition may require more than "confidence >= bar" is ` +
        `checking for. If this bot doesn't already have a floor-deadlock backstop (force the next call through as a one-off ` +
        `once stalled at the floor for long enough, so real evidence keeps reaching the win/loss record), it needs one — and ` +
        `if it does have one, this finding means that backstop itself isn't firing and is worth checking directly.`,
    },
  };
}

function ruleStrongAndStable(m) {
  if (m.lifetimeRate === null || m.total < m.minSamplesForVerdict) return null;
  if (m.lifetimeRate < 60 || m.adaptFlips >= 3) return null;
  return {
    rule: "STRONG_AND_STABLE",
    severity: "info",
    message: `${m.name}: lifetime win rate ${m.lifetimeRate.toFixed(0)}% over ${m.total} calls, tuning has settled (no thrashing) — performing well, no action needed.`,
    autoApplicable: false,
  };
}

// Confidence-calibration check for bots that expose {confidence, outcome}
// pairs (Fusion Bot, Sentinel Bot via its bucket stats, the permanent Call
// History log, bsState). Buckets calls into low/mid/high confidence and
// checks that higher-confidence calls actually win more — if they don't,
// the confidence NUMBER itself is misleading, which is a formula problem
// (logic), not a threshold problem, so this is always a PROPOSAL.
function ruleConfidenceMiscalibration(name, calls) {
  const scored = (calls || []).filter((c) => typeof c.confidence === "number" && (c.outcome === "win" || c.outcome === "loss" || c.outcome === "correct" || c.outcome === "wrong"));
  if (scored.length < 20) return null;
  const isWin = (c) => c.outcome === "win" || c.outcome === "correct";
  const buckets = { low: [], mid: [], high: [] };
  for (const c of scored) {
    const b = c.confidence < 55 ? "low" : c.confidence < 75 ? "mid" : "high";
    buckets[b].push(isWin(c) ? 1 : 0);
  }
  const rate = (arr) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) * 100 : null);
  const lowRate = rate(buckets.low), midRate = rate(buckets.mid), highRate = rate(buckets.high);
  if (highRate === null || lowRate === null) return null;
  if (highRate >= lowRate + 5) return null; // calibrated the way you'd expect — no finding
  return {
    rule: "CONFIDENCE_MISCALIBRATION",
    severity: "action",
    message: `${name}: high-confidence calls (${highRate.toFixed(0)}% win, n=${buckets.high.length}) are not outperforming low-confidence calls (${lowRate.toFixed(0)}% win, n=${buckets.low.length}) — the confidence number isn't tracking real accuracy.`,
    autoApplicable: false,
    alsoPropose: {
      title: `${name}: confidence formula may need revisiting`,
      body:
        `Across ${scored.length} scored calls, mid-confidence calls came in at ${midRate === null ? "n/a" : midRate.toFixed(0) + "%"}. ` +
        `A well-calibrated confidence score should rank low < mid < high in actual win rate. Since it doesn't here, anything ` +
        `downstream that trusts this number at face value (entry gating, position sizing, other bots' fusion weighting) is ` +
        `working off a noisier signal than it assumes. Worth reviewing what feeds this bot's confidence calculation and whether ` +
        `its inputs/weights still reflect current market behavior.`,
    },
  };
}

// Regime-memory drift check (see regimeStats/regimeWeight on sentinelBot/
// corrBot in index.html, and summarizeRegimeMemory in buildOverseerSnapshot,
// which is what feeds `summary` here). A regime with a strong, well-sampled
// track record should have a regimeWeight that reflects it — that's the
// whole point of the axis: "recognize a market I've done well/poorly in
// before and tune back toward what worked". If a regime has plenty of
// samples and a lopsided win rate but its weight is still sitting near 1.0
// (or otherwise far from what that accuracy would produce), the LEARNED
// multiplier isn't keeping up with the RECORDED evidence behind it — a sync
// problem in the client's own adapt function, not a threshold problem, so
// (like ruleConfidenceMiscalibration) this is always a PROPOSAL, never
// auto-applied; the Overseer never edits index.html.
function ruleRegimeWeightDrift(name, summary, learnParams) {
  if (!summary || !Array.isArray(summary.top) || !summary.top.length) return null;
  var lp = learnParams || { minSamples: 8, divisor: 200, clampMin: 0.85, clampMax: 1.15 };
  // Only judge regimes with real weight behind them — comfortably past the
  // client's own minSamples floor, so a freshly-qualified regime that just
  // barely crossed the bar (and hasn't had many adapt passes yet) doesn't
  // get flagged for lagging behind evidence it only just accumulated.
  var judgeFloor = Math.max(15, lp.minSamples * 2);
  var offenders = [];
  for (var i = 0; i < summary.top.length; i++) {
    var r = summary.top[i];
    if (!r || r.total < judgeFloor) continue;
    var rate = r.correct / r.total * 100;
    var expected = Math.max(lp.clampMin, Math.min(lp.clampMax, 1 + (rate - 50) / lp.divisor));
    var actual = typeof r.weight === "number" ? r.weight : 1;
    if (Math.abs(actual - expected) >= 0.06) {
      offenders.push({ key: r.key, total: r.total, rate: rate, expected: expected, actual: actual });
    }
  }
  if (!offenders.length) return null;
  offenders.sort(function (a, b) { return Math.abs(b.actual - b.expected) - Math.abs(a.actual - a.expected); });
  var worst = offenders[0];
  return {
    rule: "REGIME_WEIGHT_DRIFT",
    severity: "action",
    message: `${name}: regime memory fingerprint "${worst.key}" has ${worst.total} scored calls running ${worst.rate.toFixed(0)}% but its learned weight (×${worst.actual.toFixed(2)}) doesn't match what that accuracy would produce (×${worst.expected.toFixed(2)}) — ${offenders.length} fingerprint(s) total showing this drift, out of ${summary.regimesWithHistory} with enough history to judge.`,
    autoApplicable: false,
    alsoPropose: {
      title: `${name}: regime-memory weight drifting from its own recorded accuracy`,
      body:
        `Regime memory is supposed to recognize "I've dealt with this exact kind of market before" and tune confidence back ` +
        `toward whatever multiplier level worked under that fingerprint last time (see regimeStats/regimeWeight and ` +
        `sentinelBotAdaptRegimeWeight/corrBotAdaptRegimeWeight in index.html). At least ${offenders.length} fingerprint(s) with ` +
        `plenty of scored samples have a weight that's drifted noticeably from what their own recorded win rate would produce ` +
        `under the bot's own learnParams formula (1 + (rate-50)/divisor, clamped). Worst case: "${worst.key}" — ${worst.total} calls, ` +
        `${worst.rate.toFixed(0)}% correct, weight ×${worst.actual.toFixed(2)} vs. an expected ×${worst.expected.toFixed(2)}. This can happen ` +
        `if the adapt function's minSamples/blend/divisor changed after this fingerprint's stats had already partly converged (see the ` +
        `LEARNING PATTERN EXCHANGE, which nudges learnParams over time), or if a code path is updating regimeStats without also calling ` +
        `the matching adapt function. Worth checking that every regimeStats update site also calls its adapt function, and that a ` +
        `learnParams change doesn't leave already-converged weights stranded at their old target.`,
    },
  };
}

function analyzeBot(m) {
  const rules = [ruleInsufficientData, ruleStuckAtCeilingLosing, ruleStalledAtFloor, ruleOscillatingNoProgress, ruleDegradingRecent, ruleStrongAndStable];
  const findings = [];
  for (const r of rules) {
    const f = r(m);
    if (f) findings.push(f);
  }
  return findings;
}

module.exports = { normalizeBot, analyzeBot, ruleConfidenceMiscalibration, ruleRegimeWeightDrift };
