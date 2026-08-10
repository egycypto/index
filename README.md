# Overseer Bot

A supervisor bot for the other bots in this project: server.js's Agent Bot,
and the browser's Agent Bot / Shadow Bot / Fusion Bot / Sentinel Bot / Call
History. It watches their outcomes and self-tuning, flags problems, and can
fix a narrow, bounded class of them by itself.

## What it does

Every ~5 minutes (`ANALYSIS_INTERVAL_MS`) it:

1. **Reads.** Polls `server.js`'s `GET /api/state` directly. Receives a
   summary snapshot pushed from the browser page every 60s (index.html now
   POSTs to this bot's `/ingest` — see the "OVERSEER EXPORT" block near the
   end of its inline script). It never reaches into a browser tab; it only
   sees what the page chooses to send, and only summary win/loss/adapt-log
   stats, never raw private state.
2. **Analyzes.** Runs a shared rule engine (`rules.js`) against each bot:
   stuck-at-ceiling-and-still-losing, pinned-at-floor-with-nothing-clearing-it
   (`STALLED_AT_FLOOR` — the bar has been eased all the way down and total
   scored calls still hasn't moved for several cycles straight, meaning
   there's no numeric knob left to turn and it's a logic problem upstream of
   the bar, not a threshold problem), oscillating tuning with no real
   progress, a recent cold streak diverging from the lifetime rate, (for
   bots that expose confidence+outcome pairs) whether higher-confidence
   calls actually win more often than lower-confidence ones, and (for bots
   that expose a `regimeMemory` summary — see "Regime Memory" below)
   whether a well-sampled market-regime fingerprint's learned weight
   actually matches the accuracy recorded behind it (`REGIME_WEIGHT_DRIFT`).
3. **Acts, within a hard leash.**
   - **Low-risk numeric tuning** (a few specific rules — see
     `AUTO_APPLY_RULES` in `overseer.js`) gets auto-applied directly to
     `tuning.json`, a small shared config file that `server.js` and
     `index.html` were patched to read every cycle. Every change is bounded
     by `HARD_BOUNDS` in `overseer.js` (independent of whatever a rule asks
     for) and logged to `tuning-changes.log` with a before/after and reason.
   - **Everything else** — anything that looks like a logic problem rather
     than a threshold problem (e.g. "the confidence bar is maxed out and
     it's still losing, a tighter bar alone won't fix that") — gets written
     as a plain-English proposal to `proposals/<timestamp>-....md` for you
     to read and decide on. The overseer never edits `server.js`,
     `index.html`, or `call-history.js` itself.
4. **Reports.** A full markdown report goes to `reports/<timestamp>.md`
   every cycle; one line per cycle goes to `overseer.log`.

## What it will never do

- Edit any `.js`/`.html` source file.
- Push a tuning value outside the fixed ranges in `HARD_BOUNDS`
  (`overseer.js`) — those bounds are not exposed to `tuning.json` or any
  rule, so a bug in a rule can't blow past them.
- Touch anything about entry/exit logic, position sizing, or real money —
  everything in this project is paper trading; the Overseer Bot only ever
  nudges *when a bot is allowed to consider itself confident enough to act*,
  never *what it does once it's confident*.

## Running it

```bash
cd overseer
node overseer.js
```

No npm install needed — plain `http`/`fs`, same style as `server.js`.

Environment variables (all optional):

| Var | Default | What |
|---|---|---|
| `OVERSEER_PROJECT_DIR` | `..` (parent of this folder) | Where `tuning.json` lives — must match where `server.js` looks for it |
| `OVERSEER_SERVER_URL` | `http://localhost:8787/api/state` | server.js's state endpoint |
| `OVERSEER_PORT` | `8788` | This bot's own HTTP port |
| `OVERSEER_ANALYSIS_INTERVAL_MS` | `300000` (5 min) | How often it analyzes and (maybe) acts |

If you serve/open `index.html` from somewhere other than `localhost`, set
`window.BTC_OVERSEER_URL` before the main script runs (e.g. a small
`<script>window.BTC_OVERSEER_URL = "http://your-host:8788";</script>` in the
`<head>`) so the page knows where to send its snapshots and fetch tuning
from. If the Overseer Bot isn't reachable, both the export and the tuning sync
fail silently and every bot behaves exactly as it did before this existed.

## HTTP API

- `GET /tuning` — current tuning.json (also what index.html/server.js read)
- `POST /ingest` — browser page pushes its snapshot here
- `GET /report` — the latest analysis result as JSON
- `POST /analyze-now` — force an analysis cycle immediately (useful for
  testing, or right after you've made a change you want checked)
- `GET /health` — liveness + whether it's heard from the browser recently

## Extending it

`rules.js` is pure functions, no I/O — add a new rule function, add it to
the list in `analyzeBot()`, and decide in `overseer.js`'s
`AUTO_APPLY_RULES`/`HARD_BOUNDS` whether it's ever allowed to act on its
own or should always come out as a proposal. Fusion Bot's per-engine
weights and Sentinel Bot's skew/call-agreement buckets use a different
shape (a vector of weights, not one bar) — they're monitored and get
calibration checks today, but nothing auto-tunes their specific formulas
yet; that's a natural next rule to add following the same
propose-first-then-graduate-to-auto-apply pattern used here.

Correlation Bot (`corrBot` in `index.html`) now uses this same
vector-of-weights shape too, not just a single confidence bar: on top of
`corrLearner`'s combined 5-axis key ($ volume tier / TPS tier / $-skew /
tx-rate skew / Polymarket odds — see below), each of those 5 axes carries
its own learned confidence multiplier
(`volTierWeight`/`tpsTierWeight`/`usdSkewWeight`/`tpsSkewWeight`/`polySkewWeight`),
re-derived from that axis's own bucket-level call accuracy
(`volTierAcc`/etc), same bounded-nudge shape (0.85–1.15 per axis, combined
product clamped to 0.75–1.35) as Sentinel's `skewBucketWeight` and
friends. Like Fusion/Sentinel's weight vectors, this formula is monitored
but not yet auto-tuned by the Overseer itself — same natural-next-rule
note as above applies here too.

### Correlation Bot's 5th axis: Polymarket

Correlation Bot's job is testing whether an outside signal actually
correlates with what price does next. Its first four axes are all derived
from this exchange's own order flow ($ volume, TPS, $-skew, tx-rate skew).
The 5th axis is a genuinely independent one: Polymarket's live "Bitcoin Up
or Down" market odds — real money, on a separate venue, betting on the
same UP/DOWN question this bot is trying to answer.

It polls Polymarket's public Gamma API (`https://gamma-api.polymarket.com`,
no key required, CORS-enabled) every 30s — independent of the bot's own 3s
tick, since the underlying market doesn't move that fast and there's no
reason to hammer an external API for it. Rather than hand-building the
current 5-minute window's market slug (fragile Eastern-Time/DST boundary
math), it asks Gamma for active, not-yet-closed markets ordered
soonest-to-close and takes the first one that looks like a Bitcoin
Up-or-Down market. The live "Up" outcome price (0–1) is bucketed the same
buy/sell/neutral way as the $-skew and tx-rate-skew axes (>55% / <45%
split). A failed fetch or a stale reading (nothing fresh in 5 minutes)
falls back to neutral rather than yanking the axis around on one bad
request.

**Known-fixed: Correlation Bot's confidence clamp was silently broken.**
`combinedMult` (the product of all per-axis learned multipliers) was being
clamped with `CORR_COMBINED_MULT_MIN`/`CORR_COMBINED_MULT_MAX`, but those
two constants were referenced without ever being declared anywhere in the
file — every tick threw a `ReferenceError` right after committing that
tick's traffic reads, caught only by the tick scheduler's outer
`try/catch` (logged to the console, nothing else). In practice this meant
Correlation Bot never got past its first real read: no entry ever made it
into `history`/`pendingQueue`, so it could never score a call or learn
anything. Fixed alongside adding the Polymarket axis by actually declaring
both constants (`0.75`/`1.35`, matching Sentinel's own clamp).

## Sentinel Bot now cross-checks Correlation Bot

Sentinel Bot's confidence calculation now includes a 6th factor: whether
its own committed direction agrees or disagrees with Correlation Bot's
current live read (`corrBot.lastReading.direction`). This is the same
"cross-bot agreement" idea Sentinel already used for the Buy/Sell Zone
panel (`callAgreeStats`/`callBucketWeight`), just checking a second,
independent bot's opinion instead — one that's itself testing "does
traffic/Polymarket odds predict price" rather than a hand-tuned zone rule.

- `sentinelBot.corrAgreeStats` / `corrBucketWeight` track and learn a
  bounded (0.85–1.15) confidence multiplier per bucket (`agree` /
  `disagree` / `noRead`), same shape and same 8-sample warm-up as every
  other Sentinel weight axis.
- The bucket is computed fresh each Sentinel tick from whatever
  Correlation Bot's most recent reading happens to be — Correlation Bot
  ticks on its own 3s clock, so this is a few seconds stale relative to
  any single Sentinel tick, but it's still the freshest cross-check
  available, and unlike the Buy/Sell Zone panel it comes from a bot doing
  the same "does this actually predict price" analysis Sentinel is.
- Nothing is assumed about whether agreement helps — that's exactly what
  the learned multiplier finds out from real outcomes, the same way every
  other Sentinel axis already works. The panel shows the live agree/
  disagree/no-read win rates and multipliers directly ("Vs. Correlation
  Bot").
- Wired into persistence, the Overseer export snapshot, and the panel's
  recent-ticks/current-read lines the same way `callBucket` already was.

## Sentinel Bot's tick rate: 5s → 2s

`SENTINEL_TICK_MS` dropped from 5000 to 2000 by request, for a faster
read/commit cadence — same "only the read rate got faster" change
Correlation Bot's own `CORR_TICK_MS` already went through (10s → 3s). To
avoid that alone silently changing what the bot's numbers mean:

- `SENTINEL_HORIZON_TICKS` went from 6 to 15 (6×5s = 15×2s = still 30s) so
  a committed call is still scored against the same real-world ~30s-later
  outcome as before — scoring against a shorter horizon would just be
  measuring noise, not a signal.
- `SENTINEL_STALL_TICKS` went from 30 to 75 (30×5s = 75×2s = still ~2.5
  min) so the floor-deadlock stall breaker still only fires once every
  ~2.5 real-world minutes, not once every ~1 minute as a side effect of
  the faster tick.
- `SENTINEL_PATTERN_LEN` (3 ticks) was deliberately left unscaled — its
  real-world span shrinks from ~15s to ~6s, but widening it to match would
  blow up the fine-grained pattern key's already-large combo space and
  slow down how quickly the learner sees a given pattern twice (see the
  comment above `sentinelLearnerCoarse`), for no clear benefit.


## Regime Memory: recognizing a market Sentinel/Correlation Bot has already dealt with before

Every axis both bots already tune (skew tier, traffic bucket, agree/
disagree-with-another-bot, $-volume tier, Polymarket lean, etc.) answers
"how has THIS ONE INPUT been paying off lately" — none of them remember
the whole shape of the market as its own thing, and none of them ever go
back and prefer a setup either bot has specifically succeeded under before
once conditions move on and later swing back around to it. That's what
this adds.

Both bots already build a single fused key every tick that stands in for
"what kind of market does this tick look like":

- **Correlation Bot**: `tendencyKey`, the combined
  `volTier|tpsTier|usdSkew|tpsSkew|polySkew` key `corrLearner` already
  keys its direction predictions on (see "Correlation Bot's 5th axis"
  above) — up to 324 distinct combinations.
- **Sentinel Bot**: the coarse key `sentinelBuildCoarseKey` already builds
  (volume-skew letter, traffic letter, order-book-imbalance letter,
  funding letter, OI letter, Current-Call letter, fused into one string) —
  also a bounded, fixed-alphabet key space.

Both keys already fed a *direction* learner (`corrLearner`/
`sentinelLearnerCoarse`) whose lifetime table never resets. What was
missing was the other half: does **this bot's own call** actually do well
under that exact combined fingerprint, and if so, trust it more the next
time that fingerprint recurs. `regimeStats` (fingerprint → `{correct,
total}`, permanent, never reset) and `regimeWeight` (fingerprint →
confidence multiplier, re-derived from `regimeStats` by
`sentinelBotAdaptRegimeWeight`/`corrBotAdaptRegimeWeight`) close that gap,
using the exact same bounded-nudge shape (`learnParams`: 8-sample minimum,
0.85–1.15 clamp, blend 0.2) as every other axis, folded into
`combinedMult` the same way. The effect: a market regime either bot has
specifically proven itself in before — high scored accuracy under that
exact fingerprint — gets its confidence trusted more the next time that
same fingerprint shows up, even if the market spent hours or days
somewhere else in between. Both bots are effectively recognizing "I've
dealt with this exact kind of tape before, and here's how well that
went," and tuning themselves back toward whatever multiplier level worked
then, rather than only ever reacting to the last few ticks. Both panels
show a "Regime memory" line: the live fingerprint, how many times it's
been seen and scored before, its win rate, its current ×multiplier, and
the running count of distinct regimes learned so far (permanently).

Neither key's space needs pruning — both are fixed-alphabet combinations
(bounded the same way `CORR_MIN_KEY_SAMPLES`'s "up to 324 combinations"
already assumes), so the tables just fill in over the bot's lifetime and
stay filled, persisted in the same localStorage blob as every other
learned axis (`regimeStats`/`regimeWeight` restored wholesale on load,
since the key space is dynamic rather than a small fixed enum like the
other axes' buckets).

This is the same shape as every other weight-vector axis in this project
(see "Extending it" above): it's monitored by the panel and tunes itself
continuously. As of this update the Overseer now goes a step further than
just monitoring: **`REGIME_WEIGHT_DRIFT`** (`rules.js`) checks whether a
regime with a well-sampled track record actually has the weight that
track record would produce, and — same as every other logic-level finding
— writes a proposal (never auto-applied; the Overseer never edits
`index.html`) if a fingerprint's learned multiplier has drifted noticeably
from its own recorded accuracy. This is the same idea as
`CONFIDENCE_MISCALIBRATION` (does the confidence NUMBER track real
accuracy) applied one level deeper (does the regime-memory WEIGHT track
the accuracy record it was itself derived from).

To make that possible, **Correlation Bot is now fully exported to the
Overseer** (`corrBot` in `buildOverseerSnapshot`, `index.html`) — it was
previously missing from the snapshot entirely (only its `learnParams`
surfaced, indirectly, via the Learning Pattern Exchange block), so no rule
in `rules.js` could ever run against it: no win/loss trend check, no
`CONFIDENCE_MISCALIBRATION`, nothing. It now gets the exact same shape
Sentinel Bot already had — wins/losses, `confThreshold` (bounded 50–75,
same as Sentinel's own bar), `adaptLog`, recent outcomes, confidence+
outcome pairs for calibration, and its own `regimeMemory` summary — so the
Overseer can watch and flag it in a report for the first time.

`regimeMemory` itself (both bots) is a compact, capped summary built by
`summarizeRegimeMemory` right inside `buildOverseerSnapshot` — total
distinct fingerprints seen, how many have crossed the minimum-sample bar
to mean anything, and the top 20 by sample count (key/total/correct/
weight) — never the full table, consistent with this export's existing
"summary stats, never raw private state" rule.

Sentinel Bot's success rate could previously freeze permanently: its
win/loss record only updates from calls that clear its adaptive
`confThreshold` bar (`highConf`), and the stall-breaker meant to ease that
bar down after a stretch of no high-conviction calls stopped adjusting
anything once the bar hit its floor (`SENTINEL_MIN_THRESHOLD`, 50%) — with
nothing left to ease and no other mechanism to clear the bar, the win/loss
record could stay frozen indefinitely even while the bot kept ticking
normally. Fixed in `index.html`'s `runSentinelBot()`: once a full stall
window passes *at* the floor, that one tick's call is forced through as
high-conviction so real evidence keeps reaching the win/loss record — rare
enough (once per ~2.5 min stall window, only at the loosest the bar is
allowed to go) that it can't be used to game the bar, only to unstick a
genuine deadlock. `STALLED_AT_FLOOR` (see above) is the Overseer-side
detector for this same pattern, for this bot or any other.
