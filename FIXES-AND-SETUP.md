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

## 5. Not done

The AI agent backend and its network animation are still just the approved
concept — no code written for them yet. The honest-labelling point from that
concept still stands: digits on these indices are independent draws, so past
frequency doesn't shift the odds of the next tick. Build the agent as a fast,
legible execution instrument with hard caps that actually halt a run, and label
its output as deviation rather than win probability.

## 6. What "error-free" means here

This build compiles, type-checks and passes its tests. It has **not** been run
against a live Deriv socket — this environment blocks derivws.com, so every
connection attempt returned 403 from the proxy. Anything that only executes
with a real token and a live feed is unverified. Test on a **demo account**
first.
