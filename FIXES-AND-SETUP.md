# Digit X Matrix — fixes applied and setup required

## 0. Critical fix from your browser console log (this round)

Your console log showed cascading failures: "No symbols found", "Invalid
symbol provided to getContractsFor", "Trading times fetch timeout", "Active
symbols fetch timeout", and a 400 from `/api/bulk/start`. All of it traced to
one root cause.

**The app was pointed at two different, incompatible Deriv products.** Deriv
has a classic protocol (`wss://ws.derivws.com/websockets/v3`, plain messages
like `{authorize: token}`, a `symbol` field) and a newer, separate "Options
Trading API" (`api.derivws.com/trading/v1/options`, REST + a one-time-password
URL, a differently-named `underlying_symbol` field). They are not
interchangeable — a client built for one cannot talk to the other.

This app's trading code (`@deriv/deriv-api`'s `DerivAPIBasic` on the frontend,
and this project's own `StrategyEngine`/`aiAgent`/`marketFeed` on the backend)
is built entirely for the **classic** protocol — every message it sends uses
`symbol`, not `underlying_symbol`. But the socket URL construction
(`src/components/shared/utils/config/config.ts` on the frontend,
`backend/src/derivConnection.js` on the backend) had been pointed at the
**newer Options endpoint** instead. The frontend was even sending an explicit
classic-style `{authorize: token}` message *into* an OTP-pre-authenticated
Options connection that doesn't expect one — hence "Uncaught (in promise)
Object" right after "WebSocket connection established" in your log.

Every `active_symbols`, `contracts_for`, and `trading_times` request sent
after that point had nowhere valid to land, so it just timed out — which
cascaded into the empty symbol list, the "Invalid symbol" errors, and
ultimately the `/api/bulk/start` 400 when the backend's own `derivConnection.js`
hit the identical mismatch trying to authorize.

**Fixed** by making both sides consistently use the classic protocol:
- `src/components/shared/utils/config/config.ts` — `getSocketURL()` now
  always returns `wss://ws.derivws.com/websockets/v3?app_id=...` instead of
  routing through the OTP-authenticated Options endpoint. The existing
  `.authorize(token)` call in `api-base.ts` is the real auth step and was
  already written for this protocol.
- `backend/src/derivConnection.js` — rewritten to the same single-step
  `{authorize: token}` handshake `marketFeed.js` already used, replacing the
  REST-account-lookup + OTP flow.
- `backend/src/marketFeed.js` — dropped the Options endpoint as a fallback
  candidate; it was added defensively in an earlier round before this
  incompatibility was confirmed, and having it as a retry target would mask
  failures with more of the same silent timeouts instead of surfacing them.
- Added `NEXT_PUBLIC_DERIV_WS_APP_ID` (frontend) and confirmed
  `DERIV_WS_APP_ID` (backend, from a previous round) — both **numeric** app
  IDs, separate from your alphanumeric OAuth login client ID, required by the
  classic protocol. Both default to Deriv's shared public test id (`1089`)
  if unset.

**Verified:** full `tsc --noEmit`, `npm run build`, and `npx jest` (42/42
suites) all pass with this change. The AI agent's standalone logic test
(config clamping, gate pass/reject, execute/settle) still passes unchanged,
since it runs against fakes and isn't affected by which real endpoint is used.

**Not verified:** actual login and trading against Deriv's live classic
endpoint — this sandbox cannot reach derivws.com. This is the highest-value
thing to test first once you deploy: log in, open the Bulk Trades tab, and
confirm the digit grid populates and symbols load. If it doesn't, register
your own numeric app_id at api.deriv.com and set `DERIV_WS_APP_ID` /
`NEXT_PUBLIC_DERIV_WS_APP_ID` rather than relying on the shared `1089` test id
for real use.

---

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
| `DERIV_WS_APP_ID` | Optional, defaults to `1089` (Deriv's shared public test id). Numeric app_id for the backend's classic-protocol connection — see section 0. Register your own before real use. |

---

## 2. The websocket endpoint needs your attention

`backend/src/marketFeed.js` speaks the Deriv **v3** message protocol —
`ticks_history`, `active_symbols`, `msg_type` responses. The documented
endpoint for that protocol is:

```
wss://ws.derivws.com/websockets/v3?app_id={NUMERIC_APP_ID}
```

The original code pointed at `wss://api.derivws.com/trading/v1/options/ws/public`
instead, which belongs to the newer Options API — a different gateway that
authenticates via an OTP obtained from a REST call, not a `/public` path.

Two credentials are involved and they are easy to confuse:

- `NEXT_PUBLIC_DERIV_APP_ID=34o9mFaY1HjSSSXyE5DuL` — alphanumeric OAuth client
  ID, used for **login**. Correct as-is.
- `DERIV_WS_APP_ID` — a **numeric** app_id you register at api.deriv.com, used
  for the **v3 websocket**. Not yet set; currently falls back to `1089`, which
  is Deriv's shared public test ID. Register your own before real use.

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

