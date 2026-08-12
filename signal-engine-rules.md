# SIGNAL Engine — Rules & Data Reference

Companion reference for `btc_live.html`. This file documents *how the bot
decides*, not live data — the engine's actual learned numbers (weights,
regimes, correlations, activity baseline, prediction history) live in:

- **Browser localStorage**, key `signalEngineState_v1` (auto-saved, survives refresh)
- **A linked file on disk**, if you've used "Link Data File (auto-save)" in the
  Engine Settings panel — same JSON shape as below, kept in sync automatically
- **A manual export**, if you've used "Export Memory (JSON)" — a timestamped
  snapshot you can archive or move between machines with "Import Memory (JSON)"

If you update the rules below, the code in `btc_live.html` is the source of
truth — this file should be kept in sync with it by hand.

---

## 1. Inputs the engine reads

For six trailing windows — **1s, 5s, 10s, 15s, 30s, 1h** — every tick it reads:

- **Net transactions**: `(buyCount − sellCount) / (buyCount + sellCount)` → range −1..+1
- **Net volume**: `(buyVolume − sellVolume) / max(0.05, buyVolume + sellVolume)` → clamped −1..+1

Plus one more input:

- **Polymarket skew**: `(probUp − 0.5) × 2` from the 5-minute "up" probability panel → −1..+1

That's **13 features total** (`tx_1s, vol_1s, tx_5s, vol_5s, … tx_1h, vol_1h, poly`).

---

## 2. Correlation gating — how much to trust each input right now

Every second, the engine samples each feature alongside the price change over
that same window and keeps a rolling ~3-minute Pearson correlation
(`correlations[panel].tx`, `.vol`, and `polyCorr`).

Each feature's contribution to the score is scaled by:

```
gate(feature) = 0.4 + 0.6 × |correlation|      // range 0.4 .. 1.0
```

A feature with zero measured correlation to price still contributes at 40%
weight (never fully zeroed out); a feature correlating strongly (|r|→1)
contributes at full weight. This is re-learned continuously — it is not a
fixed table.

---

## 3. Market activity classification (tx count + traded volume)

**Purpose:** recognize how busy the market is right now, independent of
direction, and use that to scale how much to trust a call.

- **Window measured:** trailing 20 seconds
- **Metrics:** `txPerSec = (buyCount+sellCount)/20`, `volPerSec = (buyVol+sellVol)/20`
- **Baseline:** a slow-decay running mean & variance for each metric, learned
  purely from monitoring this engine's own tape (learning rate α = 0.01 per
  tick, ≈ a couple of minutes to substantially re-center). No hardcoded
  "normal" volume number exists anywhere in the code — it is *always*
  relative to what this session has actually observed.
- **Minimum samples before trusted:** 45 ticks (~45s). Before that, level =
  `calibrating` and no confidence adjustment is applied.
- **Composite z-score:** `z = (zTx + zVol) / 2`, each `z = (current − mean) / stddev`

### Level thresholds (on the composite z-score)

| Level        | z-score range     |
|--------------|--------------------|
| `very_low`   | z ≤ −1.25          |
| `low`        | −1.25 < z ≤ −0.4   |
| `normal`     | −0.4 < z ≤ 0.4     |
| `high`       | 0.4 < z ≤ 1.25     |
| `very_high`  | 1.25 < z ≤ 2.25    |
| `aggressive` | z > 2.25           |

### Effect on decision logic

Direction (UP / DOWN / FLAT) is **not** affected — that still comes purely
from the weighted, correlation-gated score. Only **confidence** is scaled,
via a multiplier applied at the moment a call opens:

| Level        | Confidence multiplier | Rationale |
|--------------|-----------------------|-----------|
| `very_low`   | × 0.85                | thin tape is noisier, less trustworthy |
| `low`        | × 0.93                | |
| `normal`     | × 1.00                | baseline |
| `high`       | × 1.08                | broader participation, more reliable |
| `very_high`  | × 1.15                | |
| `aggressive` | × 0.92                | spikes are as often exhaustion/reversal as continuation — pulled back slightly rather than chased |
| `calibrating`| × 1.00                | not enough monitoring yet — stay neutral |

The level active at the moment a call opens is stored on that call
(`activityLevel`) and shown in the Prediction History table.

---

## 4. Scoring & classification

```
score = Σ over all 13 features of:  weight[feature] × featureValue × gate(feature)

label = "UP"   if score >  scoreThresh
        "DOWN" if score < -scoreThresh
        "FLAT" otherwise

confidence = clamp(50 + min(|score|, 1.2) × 45 × confGain × activityMultiplier, 50, 99)
```

- `scoreThresh` starts at 0.05 and self-adjusts (see §5).
- `confGain` starts at 1.0 and self-adjusts (see §5).

---

## 5. Learning — how weights, confidence, and thresholds adapt

A call opens, runs for `horizonSec` (default 30s), then is graded against the
actual price change (`tolerancePct`, default ±0.008%, decides UP/DOWN/FLAT
for the *actual* outcome).

**Weight update** (simple gradient step), on every graded call:

```
target = +1 (UP) / −1 (DOWN) / 0 (FLAT)
error  = target − clamp(score, −1, 1)
for each feature: weight[feature] += lr × error × featureValue × gate(feature)
then renormalize so Σ|weight| = 1
```

`lr` (learning rate) defaults to 0.04, adjustable in Engine Settings.

**Confidence gain** — nudged toward matching realized accuracy:

```
confGain = clamp(confGain + (rollingSuccessRate − rollingAvgConfidence)/100 × 0.06, 0.5, 2.0)
```

**Score threshold** — tightened when the rolling success rate is weak,
loosened slightly when it's strong, checked every 5th graded call:

```
scoreThresh = clamp(scoreThresh × (successRate < 80% ? 0.96 : 1.01), 0.01, 0.5)
```

---

## 6. Pattern memory (regimes)

Every graded call also updates a "regime centroid" (an exponential moving
average of that regime's feature vectors, α = 0.15).

If the rolling accuracy over the last 10 calls drops below 40%, the engine:

1. Builds a centroid of those last 10 calls' features.
2. Compares it (cosine similarity × 0.7 + that regime's own historical
   success rate × 0.3) against every other known regime with ≥5 samples.
3. If the best match scores > 0.35 → **switches back** to that regime and
   its saved weights (a recognized, previously-seen market pattern).
4. Otherwise → **opens a new regime** and continues learning fresh from
   the current weights.

This is what lets the engine "recall" a market condition it has adapted to
before instead of relearning it from scratch every time conditions repeat.

---

## 7. Startup backfill

On every page load, the engine fetches the last 1,000 real trades from
Binance's public `aggTrades` endpoint and replays them through the exact
same scoring/learning/activity-classification functions the live loop uses,
on a simulated clock. This is honest backtesting on real trades (not
fabricated data), tagged `source: 'backfill'` in prediction history so it's
always distinguishable from genuinely live-graded calls. It also warms up
the correlation memory and the market-activity baseline instead of starting
those cold.

---

## 8. Data file schema (what gets saved/exported/linked)

```jsonc
{
  "weights":        { "tx_1s": 0.07, "vol_1s": 0.05, ..., "poly": 0.03 }, // 13 keys, |Σ| = 1
  "confGain":        1.0,             // 0.5 .. 2.0
  "scoreThresh":      0.05,            // 0.01 .. 0.5
  "regimes": [
    { "id": 1, "name": "Regime #1 · baseline", "weights": {...}, "centroid": {...},
      "samples": 0, "correct": 0, "lastSeen": 0, "created": 0 }
  ],
  "activeRegimeId":   1,
  "history": [
    { "time": "14:03:21", "predLabel": "UP", "predConfidence": 82,
      "actualLabel": "UP", "changePct": 0.011, "correct": true,
      "features": {...}, "ts": 0, "activityLevel": "high", "source": "backfill?" }
  ],
  "settings": { "tolerancePct": 0.008, "horizonSec": 30, "rollWindow": 30, "lr": 0.04 },
  "stats": { "totalGraded": 0, "totalCorrect": 0 },
  "panelSeries":     { "1s": {"tx":[...],"vol":[...],"chg":[...]}, ... },  // rolling correlation samples
  "polySeries":      { "skew": [...], "chg": [...] },
  "correlations":    { "1s": {"tx": 0.12, "vol": -0.03}, ... },
  "polyCorr":         0.0,
  "activityBaseline": { "txMean": 0, "txVar": 0, "volMean": 0, "volVar": 0, "n": 0 },
  "feedRows":        [ { "t": "14:03:21", "msg": "...", "cls": "sys" } ],
  "exportedAt":       0               // only present in manual exports / linked-file writes
}
```

All top-level keys are optional on import — missing keys are simply left at
their current in-memory value, so a partial or older-format file still loads
without wiping everything else.
