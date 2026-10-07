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

## 6. AI tab: Over 4 / Under 5, new contracts, switching, trend gate (2026-10-07)

Verified: `tsc --noEmit` clean, `npm run build` succeeds, `npx jest` 45/45 suites (461 tests; new ones in
`src/pages/bulk-trader/__tests__/`: `ai-contracts.spec.ts`, `contract-specs.spec.ts`, `ai-runtime.spec.tsx`).
**Not yet verified against live Deriv** (the build sandbox has no network): run it on a demo account first, see
"Check on demo". The Bulk Trades tab is unchanged (apart from one stale-settings fix, last paragraph).

### What the AI can trade now

| Contract | Deriv request | Ticks | Barrier |
|---|---|---|---|
| Over 4 / Under 5 | `DIGITOVER` / `DIGITUNDER` | 1 | digit 4 / digit 5 (exact opposites: 5-9 vs 0-4) |
| Higher / Lower | `CALL` / `PUT` | 5 | `+0.1` / `-0.1` |
| Touch / No Touch | `ONETOUCH` / `NOTOUCH` | 5, then 10 if Deriv refuses 5 on that market | 0.5 (side taken from the signal, `+` by default) |
| Multiplier Up / Down | `MULTUP` / `MULTDOWN` | none (open position) | take profit = 20% of the stake, sent with the buy |

Over 4 / Under 5 enter the AI's pool as a signal for whichever side is printing less than 50% (same deviation score
as the backend's Even/Odd and Over/Under signals; needs 60 ticks). Higher, Lower and the multipliers have no digit
statistics behind them: they are in the pool with a fixed low score and are only available while the trend gate
allows them. The learner scores every one of them on its own record (own keys: `OVER4`, `UNDER5`, `HIGHER`,
`LOWER`, `MULTUP`, `MULTDOWN`; Higher/Lower are not mixed up with Rise/Fall in the refusal list).

### Switching (`SWITCH_PARTNER` in `contractSpecs.ts`)

Even <-> Over 4 · Odd <-> Under 5 · Touch <-> Under 5 · No Touch <-> Over 4 · Rise <-> Under 5 · Fall <-> Over 4 ·
Higher <-> Under 5 · Lower <-> Over 4 (Over 4 <-> Under 5 and Multiplier Up <-> Down when they start the run).

It plugs into the AI's existing switch rules, it does not replace them: in the default reverse/flat/martingale modes
the switch happens after 2 losses in a row (`SWITCH_AFTER_LOSSES`); in "flip" mode every loss switches. A contract
we switched TO goes back to the one we left at the next switch. A win ends the loss run. If the partner cannot be
traded right then (not offered, refused, blocked by the self-review, or a trend contract whose trend is not
confirmed) the AI falls back to its old behaviour (best other contract). Contracts with no entry in the map
(Over/Under with a chosen digit, Only Ups/Downs, Asians, ...) behave as before.

### Trend gate (`trendFilter.ts`, `autoPilotEngine._trendOk`)

The AI follows the 1-tick chart (one tick = one candle) of every market it can see. A directional contract is
only offered while its market shows the matching trend:
- bullish (Rise, Higher, Multiplier Up, plus Only Ups / Asian Up / Reset Call): the last two swing highs rising;
- bearish (Fall, Lower, Multiplier Down, plus the Down versions): the last two swing lows falling;
- if both happen at once, or there is not enough history yet, neither is confirmed and the contract is skipped.

A swing point is a tick above/below the 2 ticks on each side, so it confirms 2 ticks after it forms. Touch / No
Touch and the digit contracts are not gated. Switching back to a trend contract is gated too.

### Multipliers

- x is picked from what Deriv offers for the market (closest to 100x), 100x if the list cannot be read.
- A multiplier has no expiry and the AI trades one contract at a time, so the AI waits until it closes (+20% or
  Deriv's stop-out at the stake). Pressing Stop (or any stop reason) sells a multiplier that is still open.
  Closing the browser tab leaves it open on Deriv until it hits +20% or stops out.

### Check on demo before real money

1. Higher/Lower at 0.1 and Touch/No Touch at 0.5 may be under Deriv's minimum barrier distance on some markets.
   Touch retries at 10 ticks; any other refusal puts that market/contract on the AI's 6-hour skip list, and the
   Activity log shows Deriv's message.
2. Multipliers are not offered on every market (same: refusal -> skip list).
3. `contracts_for` and `ticks_history` are sent as in the classic API. If the new Options API names them
   differently, multipliers fall back to 100x and the trend gate fills from live ticks (about 10 ticks of warm-up).

Also fixed: the Bulk Trades tab ignored changes to "Fire all at once" and "Max entry ticks" (missing from
`buildStrategyConfigs`' dependency list).

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
