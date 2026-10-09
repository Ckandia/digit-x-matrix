# Both sides after the virtual hook, except Touch / No Touch (October 2026)

- A live trade released by the virtual hook now buys BOTH sides on the same market (same stake each, same duration): Even + Odd, Over 4 + Under 5, Rise + Fall, Only Ups + Only Downs. Touch / No Touch are never both-sided (one contract only). The two legs settle as one trade, as before. A first trade of a run (no hook yet) is a single contract.
- Checkbox "Both sides" (default on) / `both_sides: false` turns it off.
- Honest note (your theory test): Even+Odd and Over 4+Under 5 always have exactly one winner, so each pair returns one payout for two stakes: with payouts of about 1.8-1.95x the stake the net is a guaranteed loss of roughly 5-20% of one stake per pair. Rise+Fall also loses both on an unchanged tick. The hook can change what you trade, not that arithmetic. Rise/Fall: only the first leg is trend-gated; the opposite leg is bought alongside it.

# Both sides for Only Ups/Downs and Touch/No Touch (October 2026)

- After the virtual hook clears an Only Ups, Only Downs, Touch or No Touch trade, the AI buys BOTH sides live on the same market: same stake on each, same duration (Only Ups/Downs 2 ticks; Touch/No Touch 5 ticks, 0.5 barrier, or 10 if Deriv refuses 5). The first side is bought, then the second one right after; if the second is refused the first runs alone.
- The two legs settle as ONE trade: the stake ladder, stop loss, take profit and the hook all see the combined (net) result. Both legs still appear separately in the journal and the learner.
- Even/Odd and Over/Under are unchanged (one contract). New checkbox "Both sides" on the AI Trader tab (on by default); `both_sides: false` in the config turns it off.
- Honest note: Touch + No Touch means exactly one side wins, so the net is positive only if the winning payout is more than 2x one stake. Only Ups + Only Downs can both lose (mixed ticks) and then you lose both stakes. Check the payouts in your results before leaning on it.

# 1-second volatilities only (October 2026)

- The Bulk Trader market picker now lists only the 1-second indices (1HZ10V, 15, 25, 30, 50, 75, 90, 100) and defaults to Volatility 10 (1s).
- The backend analysis feed (`backend/src/marketFeed.js`) streams only the five 1HZ markets (10/25/50/75/100). R_ (2-second) and Jump indices are gone.
- The live signal feed drops any non-1HZ symbol before the AI or the tabs see it, so the AI Trader can only pick, paper-test and trade 1-second markets.
- Redeploy the backend (Render) so it stops streaming the R_ markets.
- Not changed: the stock Deriv Bot builder/charts pages still list every market.

# Virtual hook: Even/Odd follows the hook (October 2026)

- In the active hook mode, **Even/Odd now trades what the virtual hook shows**: a paper WIN on Even buys Even live (Odd buys Odd). A paper LOSS no longer buys the opposite: nothing is bought, and the same contract keeps paper-testing until it wins, then it goes live.
- After 25 paper losses in a row the AI picks a fresh contract and paper-tests it (it never buys live unproven).
- Over 4/Under 5, Rise/Fall, Touch/No Touch, Only Ups/Downs still buy the OPPOSITE after a paper loss. `opposite` and `confirm` modes are unchanged.
- Honest note: Even/Odd digits are independent tick to tick, so a paper result does not predict the next live result; this rule mainly reduces the number of live trades.
- Dependencies: `package-lock.json` is out of sync with `package.json` (`npm ci` fails); use `npm install`.

# Virtual hook: "opposite" mode (October 2026)

- **Update:** the two-paper-wins rule is SUSPENDED. Opposite mode is the only active rule: no dropdown, no confirmations field, and the engine defaults to it. The old rule remains in code (`virtual_mode: 'confirm'`) and tests, not selectable in the UI.

- New field `virtual_mode` on the AI config and a dropdown under the Virtual hook checkbox on the AI Trader tab:
  **Buy the opposite after a paper loss** (new default) or **Wait for paper wins in a row** (the old rule, unchanged).
- Opposite mode: after a real loss the AI paper-trades the contract it wants next. The moment a paper trade LOSES, the
  opposite contract is bought for real on the same market at the stake the AI would have used
  (Even<->Odd, Over 4<->Under 5, Rise<->Fall, Touch<->No Touch). If that real trade loses, the hook starts again, and so on.
  A real win ends the cycle. Paper wins just keep paper trading; after 25 paper wins in a row with no loss it picks a fresh contract.
- Rise/Fall opposites still wait for the 1-tick trend gate (up to 20 tries), then pick fresh if no trend appears.
- Paper results still go to the learner. Paper trades move no money.
- Honest note: a 1-tick Even/Odd or Over/Under outcome is independent of the previous tick, so the opposite of a paper loss has
  no built-in edge (your own Oct 8 data showed no win-after-loss link). It changes WHEN and WHAT you trade, not the win rate.
  Test on demo first.
- Verified: `tsc --noEmit` clean, `npx jest` 47/47 suites (476 tests; 3 new in `virtual-hook.spec.ts`). Not run against live Deriv.

# AI Trader update (October 2026)

- **Over 4 / Under 5** are now AI Trader contracts (backend signals + fixed barriers 4 and 5, 1 tick).
- **Auto flip** (checkbox on the AI Trader tab, default on): after a loss the AI switches to the partner, after the next loss back.
  Even/Over 4, Odd/Under 5, Touch/Under 5, No Touch/Over 4, Rise/Under 5, Fall/Over 4. Higher/Lower and Multipliers (same pairs,
  20% take-profit) stay on the Bulk Trades tab, which already had them; they are not 1-tick contracts so the AI does not trade them.
- **1-tick contracts first**: barrier contracts are used only when no 1-tick contract has a signal.
- **Touch / No Touch**: barrier +0.5, 5 ticks; 10 ticks if Deriv refuses 5.
- **Rise / Fall** wait for a higher-high / lower-low on the 1-tick chart (same rule Bulk Trades uses).
- **Capital protection** (field on the AI Trader tab, default 10 trades): stake stays at the base stake and the run stops if it loses
  3 base stakes. It limits risk; it cannot guarantee the first trades are profitable.
- **Tab switching**: returning to the AI tab no longer stops a running AI (false account-mismatch check removed), the account watcher
  compares against the account active at start, Deriv connections reconnect when the page wakes/goes online (10 attempts), and Bulk
  Trades keeps recording into the run panel while another tab is open.
- **Switch after one loss**: every loss switches the contract (contracts with no listed pair switch to Under 5), then back after the next loss.
- **Virtual hook** (checkbox on the AI Trader tab, default on): after a real loss the AI places no real trades. It paper-trades on live
  ticks (Even/Odd, Over 4/Under 5, Rise/Fall, Touch/No Touch), switching contracts like real trades, until one paper trade wins; then
  real trading resumes at the stake it would have used. Paper trades move no money and do not count toward capital protection.
- **Fix (Oct 7, later):** the auto flip no longer passes through the self-review gate. The gate blocks contracts the journal shows as
  losers, and it was silently cancelling the one-loss switch. The virtual hook now has its own card on the AI Trader tab
  ("Virtual hook (paper trades, no money)": PAUSED / live status, every paper trade WIN or LOSS, running totals).
- **Stake default is now flat** (`recovery_mode: 'flat'`). From the Oct 8 transactions: 37 wins in 64 trades (57.8%), wins paid
  0.78-0.85x the stake (break-even is about 54.9%), yet the balance fell 533.20 because 28 of 64 trades ran at grown stakes
  (339 / 610) and the 610-stake trades lost five times. The same outcomes at a flat 188.34 stake would have made +698.74.
  64 trades is a small sample, so this shows the staking hurt, not that the win rate is a real edge. 'reverse' is still selectable.
- **Backend paper trader** (backend/src/paperTrader.js, endpoint `/api/paper/stats`): virtual trades on every market and contract,
  24/7, no token. Redeploy the backend (and set DATABASE_URL) for it to run while you are offline. The AI Trader tab has a new card
  with its results and a "virtual-hook check", and the learner counts the paper results as evidence for the 1-tick contracts.
  Set Learning mode to "edge gate" if you want the AI to trade only contracts that beat the payout in that data.
- **Small martingale (owner's request, Oct 8):** default Stake method is now Martingale with multiplier 1.2 (10 -> 12 -> 14.4, back to
  the base stake after a win). It is capped by "max recovery steps" (the run STOPS after that many losses in a row) and by the stop-loss
  budget. The first N "Protect capital" trades stay at the base stake, so the 1.2 growth starts after them. Switch back in the
  "Stake method" box (Flat / Reverse). On the 101 trades of the Oct 8 08:40 CSV (50.5% wins) it made no difference to the result
  on that order (-1,344 vs -1,363 flat) and was worse on average when the same results were reshuffled (-1,598, worst -8,146).
- **Virtual hook now needs two paper wins in a row (owner's request, Oct 8).** After a real loss the contract the AI wants next is
  paper-traded and must win `virtual_confirmations` paper trades IN A ROW (default **2**, field "Paper wins in a row before going live",
  1-5; 1 = the old behaviour). A paper loss resets the count and switches contract the same way real trades do (Even <-> Over 4 ...), and
  the new contract has to win its own run. When one has passed, **that same contract on that same market** is bought for real, at the
  stake the AI would have used (it used to re-pick a fresh contract). If paper trading cannot run (no ticks), the AI does not stay
  paused: it picks fresh like before. The card shows "PAUSED: paper trading X, 1/2 wins in a row".
  **Learning:** every paper result of the hook is also given to the learner (`LearningEngine.recordVirtual`, kept in the browser between
  sessions), next to the backend paper trader's results, as evidence for the 1-tick contracts (Touch/No Touch excluded, as for the
  backend). It steers which contract the AI picks (Thompson sampling / edge gate); it does not change the number of confirmations.
  **What it can and cannot do:** it throttles live trading after a loss and keeps the AI off a contract that is currently failing on
  paper. It cannot predict the next trade: on the 37 trades of the Oct 8 10:01-10:08 CSV a win followed a loss 9 times in 16 (56%) and a
  win 11 times in 20 (55%), i.e. no link, and the two runs of 4 losses are within what chance produces at ~57% wins. The 1.2 martingale
  was what made them expensive (stakes 117 -> 140 -> 169 -> 203 -> 243).
- Verified (Oct 8): `tsc --noEmit` clean, `npm run build` succeeds, `npx jest` 47/47 suites (473 tests; new: `virtual-hook.spec.ts`).
  `ai-runtime.spec.tsx` was updated for the account watcher that compares against the account active at start. Not verified against live
  Deriv or the deployed backend.

# Digit X Matrix — fixes applied and setup required

Verified on this build: `tsc --noEmit` clean, `npm run build` succeeds,
`npx jest` passes 42/42 suites (420 tests).

---

## 1. Set these before you test, or things will not work

### Frontend (`.env.production`, or Vercel environment variables)

| Variable | Why |
|---|---|
| `NEXT_PUBLIC_BULK_TRADER_API_URL` | **Currently empty.** Until it points at your Render backend (e.g. `https://digit-x-matrix-backend.onrender.com`, no trailing slash), the Bulk Trades tab shows "Bulk Trader backend URL is not configured" and the digit grid stays empty. |
| `NEXT_PUBLIC_ANALYSIS_WS_URL` | Optional. Derived from the above (`http`→`ws`, `+/ws/signals`) if unset. |

### Backend (Render environment variables)

| Variable | Why |
|---|---|
| `DERIV_WS_APP_ID` | **Numeric** app_id registered at api.deriv.com. See section 2 — this is *not* the same credential as your OAuth client ID. |
| `ALLOWED_ORIGIN` | Currently unset, so CORS is open to every origin. Set it to your Vercel domain before going live. |
| `DATABASE_URL` | Optional. Without it the backend runs fine, just without persistence. |
| `SIGNAL_RETENTION_HOURS` | Optional, defaults to 24, hard-capped at 24. See section 4. |
| `AI_AGENT_MAX_STAKE` | Optional, defaults to 25. Hard ceiling on the AI agent's per-trade stake — the frontend cannot request higher, whatever it sends is clamped. |
| `AI_AGENT_MAX_TRADES_CEILING` | Optional, defaults to 200. Hard ceiling on the AI agent's max-trades setting. |

---

## 2. The websocket endpoint — corrected 2026-09-15

**Update: this section previously recommended pointing `marketFeed.js` at the
legacy `ws.derivws.com/websockets/v3` endpoint. That guidance was wrong and
has been reversed.** As of September 2026, Deriv's own current documentation
(developers.deriv.com) states plainly to "Use ONLY" the New Options API, and
in live testing the legacy v3 gateway is returning HTTP 520s and connection
timeouts — it appears to be in the process of being sunset, alongside a
separate `legacy-api.deriv.com` / `legacy-docs.deriv.com` split that Deriv has
stood up for whatever legacy traffic still exists.

`backend/src/marketFeed.js` now tries, in order:

```
wss://api.derivws.com/trading/v1/options/ws/public   (New API, tried first)
wss://ws.derivws.com/websockets/v3?app_id={NUMERIC_APP_ID}   (legacy, fallback only)
```

The New API's public gateway needs no app_id and no auth, and serves the same
`active_symbols` / `ticks_history` / `tick` messages this file relies on — it
just renames `active_symbols`' `symbol` field to `underlying_symbol`, which
`marketFeed.js` now reads with a fallback for either name. The `ticks` and
`ticks_history` messages are unchanged field-for-field.

`DERIV_WS_APP_ID` (a numeric app_id, separate from the alphanumeric
`NEXT_PUBLIC_DERIV_APP_ID` OAuth client ID used for login) is now only needed
if the legacy fallback is ever actually reached — harmless to leave unset.

**Not yet verified:** these fixes were made by reading Deriv's current docs
and the code, not by running the app end-to-end (no live network in this
tool's sandbox). Redeploy and check the Render logs / browser console; paste
back anything that still errors.

The feed now tries endpoints in order and rotates to the next if one delivers
no usable data, logging which URL it dialled. If the digit grid is empty,
the backend log will tell you which endpoint failed instead of failing silently.

---

## 3. Bugs fixed

**Digit 0 always showed 0% (and every other digit was wrong too).**
`lastDigitOf` used `String(quote)`. Deriv sends quotes as JSON numbers, so
`184.5670` parses to `184.567` and the trailing zero is gone before the code
sees it. Digit 0 was never counted and its missing ~10% was smeared across the
other nine, inflating each to ~11.1%. Now reads each symbol's real `pip_size`
from `active_symbols`, prefers the value carried on the tick frame, keeps a
fallback map, and rebuilds any window backfilled before precision arrived.

*Check on first run:* on a 4-decimal market like R_50, digit 0 should sit near
10%, not 0%.

**API token field was invisible.** `.manual-token-slot` had no CSS anywhere in
the project — the markup existed, the styles were never written. Added an
explicit dark surface, light monospace text, visible border, and an eye toggle
to check what you pasted. It was also `isDesktop`-gated so it didn't exist on
mobile at all; now renders everywhere with a compact layout under 900px.

**No connect state.** Red "Not connected" → amber while typed but unsaved →
green "Connected" with a pulsing dot once saved. Editing the field drops back
to red so the indicator can't claim a credential that isn't in use.

**Risk checkbox gave no feedback when ticked.** Added an `--accepted` state:
green border and tint, green accent, and a ✓ before the label so it doesn't
rely on colour alone.

**Results panel missing on Bulk Trades.** `run-panel.tsx` checked
`[BOT_BUILDER, CHART].includes(active_tab)` — `BULK_TRADER` was absent, so the
Summary/Journal/Transactions panel returned `null`. Added.

**Four test suites failed to run.** `@remix-run/route-pattern` is ESM-only and
arrives transitively via react-router v7, but `transformIgnorePatterns` didn't
allowlist it, so Jest hit an `export` statement and died before any assertion.

**Stale logo test.** Hardcoded `'Deriv Trading Bot'` against your rebrand. Now
reads `brand.config.json` live so future rebrands don't break it.

**Future build breakage.** `input.scss:284` used `&:not(&--no-placeholder)`,
which compiles to adjacent compound selectors — a deprecation warning today,
a hard error in Dart Sass 2.0. Rewritten with the explicit class name.

---

## 4. Deriv API Terms compliance

Checked against **API Users terms, version R26|03, last updated 14/08/2026**.

**One violation found and fixed.** Clause 2.1 prohibits storing content that
derives or originates from Deriv's API; clause 2.3 permits caching it for at
most 24 hours. The `signal_history` table wrote a `stats` JSONB column
containing `digit_counts` and `last_digits` — tick-derived feed data — with no
expiry, accumulating forever. Added `purgeExpiredSignalHistory()`, run on boot
and hourly, hard-capped at 24 hours regardless of `SIGNAL_RETENTION_HOURS`.

**Compliant already:** clause 2.2 explicitly permits storing API tokens and
OAuth tokens, so the localStorage token is fine. The in-memory 500-tick window
is well inside the caching window.

**Worth knowing:** clause 4.3.2 places all liability for investment decisions
based on API-provided information on you, not Deriv. If you distribute this and
it trades for other people on signals presented as accurate, that exposure is
yours. Clause 1.3 also allows Deriv to block access for exceeding usage limits,
which matters if you scale up symbol subscriptions.

---

## 5. The AI agent (now implemented)

Implemented end to end, backend and frontend, not just the approved concept.

**Backend** — `backend/src/aiAgent.js` (new), plus additions to `runner.js`,
`signalHub.js`, `server.js`:

- Scores every allowed symbol's top signal once a second using the existing
  `computeSignals()` deviation math from `digitAnalysis.js` — no new scoring
  model, same honest numbers already in the Digit Matrix.
- **The confidence gate is enforced server-side, not just shown in the UI.**
  `buildAgentConfig()` clamps whatever the client sends: stake is capped at
  `AI_AGENT_MAX_STAKE` (env var, default 25), the minimum deviation threshold
  can never go below a floor of 40 no matter what's requested, max trades is
  capped at 200, and **starting without a `stop_loss` throws** — the agent
  will not run unattended without a hard exit.
- A 6-second per-symbol cooldown and a 2-second global cooldown between any
  two trades, so it can't hammer one market or overlap trades.
- Every decision the agent makes — scored, gate-passed, gate-rejected,
  executing, settled, error — is broadcast immediately on the existing
  `/ws/signals` socket as an `agent_event` frame.
- New endpoints, same token-authenticated pattern as `/api/bulk/*`:
  `POST /api/ai/start`, `GET /api/ai/status/:run_id`, `POST /api/ai/stop`.

**Frontend** — new files under `src/pages/bulk-trader/`:

- `AiAgentPanel.tsx` — config (symbols, stake, threshold, required stop loss,
  optional take profit, max trades), start/stop, live stats.
- `AiAgentPipeline.tsx` — the pipeline diagram, driven only by real
  `agent_event` frames. When the agent is idle the diagram is static, not
  animated, because nothing is actually happening yet.
- `useAiAgentEvents.ts` — subscribes to `agent_event` frames on the shared
  signals socket.
- `aiAgentTypes.ts` — shared types for config/status/events.
- `tokenStorage.ts` — the token-lookup logic, pulled out of `bulk-trader.tsx`
  so both the manual strategy builder and the AI agent read the same saved
  credential instead of each having their own copy.

Mounted at the bottom of the Bulk Trades tab, gated behind the same risk
checkbox the manual strategy builder uses.

**Verified, not assumed:**

- A standalone test of `aiAgent.js`'s logic, run against fake
  connections/market feeds (not the real Deriv API), passed all 7 assertions:
  a config with no `stop_loss` is rejected outright; stake, minimum
  confidence, and max trades are all clamped to their hard caps even when the
  input tries to exceed them; a low-confidence signal is gate-rejected; a
  high-confidence one is gate-passed, executed, and settled with the correct
  profit.
- Full project `tsc --noEmit`, `npm run build`, and `npx jest` (42/42 suites,
  420 passing tests, 1 todo) all pass with the agent code included.
- The backend boots cleanly with the agent wired in.

**Labelling stayed honest**, per the condition attached when the concept was
approved: the panel's own copy states the deviation score is not a
win-probability estimate, and the pipeline log says "deviation," never
"accurate signal" or similar.

**Not verified:** actual trade placement against a live Deriv account. This
sandbox cannot reach derivws.com, so the executor's `buy` call has only been
exercised against a fake connection in the standalone test, never the real
API. Test on a **demo account** first, and watch the pipeline log for
`gate_rejected` events with reasonable reasons before trusting `gate_passed`
ones.

---

## 6. Known pre-existing gap, not introduced by these changes

`npx eslint` fails across the whole project — `.eslintrc.js` references
`eslint-plugin-react`, which isn't listed in `package.json`'s dependencies.
Confirmed this predates every change in this document by running it against
an untouched clone of the original repo, where it fails identically.
`tsc --noEmit` and the production build are unaffected by this and remain the
authoritative checks used throughout this document.

## 7. What "error-free" means here

This build compiles, type-checks and passes its tests. It has **not** been run
against a live Deriv socket — this environment blocks derivws.com, so every
connection attempt returned 403 from the proxy. Anything that only executes
with a real token and a live feed is unverified. Test on a **demo account**
first.


---

## 6. Bulk Trades: Over 4 / Under 5, new contracts, switching, trend gate (2026-10-06)

Verified: `tsc --noEmit` clean, `npm run build` succeeds, `npx jest` 44/44 suites (450 tests; new ones in
`src/pages/bulk-trader/__tests__/`: `bulk-contracts.spec.ts` and `ai-runtime.spec.tsx`). **Not yet verified against live Deriv** (no network in
the build sandbox): test on a demo account first, see "Check on demo" below.

### What was added (Bulk Trades tab, Strategy dropdown, grouped)

| Contract | Deriv request | Ticks | Barrier |
|---|---|---|---|
| Over 4 / Under 5 | `DIGITOVER` / `DIGITUNDER` | form value (default 1) | digit 4 / digit 5 |
| Rise / Fall | `CALL` / `PUT` | form value (default 1) | none |
| Higher / Lower | `CALL` / `PUT` | 5 | `+0.1` / `-0.1` (editable) |
| Touch / No Touch | `ONETOUCH` / `NOTOUCH` | 5, then 10 if Deriv refuses 5 | `+0.5` (editable) |
| Multiplier Up / Down | `MULTUP` / `MULTDOWN` | none (open position) | take profit = 20% of stake |

### Auto Flip (switch after a loss, and back after the next loss)

Even <-> Over 4 · Odd <-> Under 5 · Touch <-> Under 5 · No Touch <-> Over 4 · Rise <-> Under 5 ·
Fall <-> Over 4 · Higher <-> Under 5 · Lower <-> Over 4. Over 4 / Under 5 started directly switch with each other;
Multiplier Up / Down switch with each other. **This replaces the old Even <-> Odd flip.** The table lives in
`contractSpecs.ts` (`SWITCH_PARTNER`).

### Trend gate (`trendFilter.ts`)

Rise/Fall, Higher/Lower and Multipliers are bought only after the 1-tick chart (each tick = one candle) confirms:
- bullish (Rise, Higher, Multiplier Up): the last two swing highs are rising (higher high);
- bearish (Fall, Lower, Multiplier Down): the last two swing lows are falling (lower low);
- if both happen at once (range widening both ways) neither side is confirmed and nothing is bought.

A swing point is a tick above/below the 2 ticks either side, so it confirms 2 ticks after it forms. Until the trend
shows, the Activity log says it is waiting. Touch/No Touch and the digit contracts are not gated. After a switch to
Over 4 / Under 5 no gate applies; switching back to a trend contract gates again.

### Multipliers

- The multiplier (x) is picked from what Deriv offers for the market (closest to 100x), or type one in the form.
- Closing at +20% is a Deriv take-profit order sent with the buy, so it works even if the tab is closed.
- A multiplier has no expiry: pressing Stop sells any that are still open. If the tab is closed mid-trade they stay
  open until they hit +20% or are stopped out at the stake; close them on Deriv if needed.

### Check on demo before real money

1. Higher/Lower at 0.1 and Touch/No Touch at 0.5 may be below Deriv's minimum barrier distance on some markets.
   Touch retries at 10 ticks automatically; if Deriv still refuses, the Activity log shows its message: raise the
   Barrier field.
2. Multipliers are not offered on every market (the log shows Deriv's reply if so).
3. `contracts_for` and `ticks_history` are sent as in the classic API. If the new Options API names them differently,
   multipliers fall back to 100x and the trend gate fills from live ticks (about 10 ticks of warm-up).

Also fixed on the way: `buildStrategyConfigs` ignored changes to "Fire all at once" and "Max entry ticks" because
they were missing from its dependency list.


---

## 7. AI auto-pilot no longer stops when you leave its tab (2026-10-06)

**Cause.** Switching tabs unmounts the AI panel. The engine, its Deriv connection and its learner were held in that
panel's refs, and the panel's unmount cleanup called `engine.stop('panel closed')` and closed the connection. The
engine also read its signals through the panel's own live-signal socket, so even without the stop it would have
carried on with frozen signals.

**Fix.**
- `aiRuntime.ts` (new): the engine, connection, learner and the run's display state (status, ladder, P/L, history,
  activity, config) now live at module level. The panel reads them with `useAiRuntime()` and re-attaches to a live
  run when you come back, without opening a second connection.
- `useDigitSignals.ts`: the signal feed is now one shared socket, held open while any tab or a running AI needs it
  (`retainSignals()`), closed when nobody does. The engine reads `getSignalSnapshots()`.
- With the AI tab closed, a run still stops itself if you switch demo <-> real in the header (checked every 2 s in
  `aiRuntime.watchAccount`), so it can never keep trading on a different account than the one on screen.
- Pressing Stop, hitting take profit / stop loss, or a lost connection still ends the run as before; it then also
  closes the connection if no AI tab is open.

Note: the run lives in the browser tab. Closing or refreshing the whole page still ends it, and on a phone the
browser may pause a background tab (the screen-awake lock is kept while a run is active).
