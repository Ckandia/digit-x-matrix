# Digit X Matrix — Backend

A small Node/Express service with one job: **the "brain"**.

- An always-on, unauthenticated feed of Deriv ticks for every digit-contract
  symbol, turned into rolling statistics and confidence-scored signals. This
  powers the digit grid, history matrix and "SIGNAL … ENTER NOW" banner on
  the **Bulk Trades** tab.
- A confidence-gated AI signal scanner that watches those same signals and
  reports (`gate_passed` / `gate_rejected`) whenever one clears the
  configured threshold.

**This backend never holds a Deriv token and never places a trade.** Both
manual "Bulk Trades" strategies and the AI agent's signals are executed
entirely in the browser, on the user's own authenticated session — see
`src/pages/bulk-trader/derivClient.ts`, `strategyEngineClient.ts`,
`bulkRunManager.ts` and `aiExecutor.ts` in the frontend repo. This service
only ever analyses and signals.

## Why a separate backend?

The live analysis feed needs somewhere to keep computing 24/7 even while
nobody has the app open, so the digit grid isn't empty on the next page
load, and the confidence-gate scan needs a consistent, shared view of every
symbol's live signals rather than ten independent per-tab feeds. That's what
this service is for — nothing more.

## The analysis "brain"

`marketFeed.js` opens **one public (no token, no login) WebSocket** to Deriv
on boot and subscribes to ticks for 10 volatility-index symbols, keeping both
a rolling last-digit window (`digitAnalysis.js`) and a rolling raw-price
window (`contractAnalysis.js`) per symbol, 500 and 300 ticks respectively.
These are turned into a ranked list of **signals** spanning 9 contract
families:

- **Digits** (`digitAnalysis.js`): Even/Odd, Over/Under 5, Differs, Matches —
  from per-digit frequency deviation against a fair-RNG baseline.
- **Rise/Fall, Reset Call/Put, Asian Up/Down** (`contractAnalysis.js`): same
  underlying momentum/drift z-score over whichever recent lookback shows the
  strongest signal, applied to three contract shapes with the same
  directional read.
- **Only Ups/Only Downs**: trailing same-direction tick run, scored against
  how often a run that length has actually continued in this window vs a
  50% fair-coin baseline (needs 25+ occurrences before it trusts the rate at
  all — small samples are noise, not signal).
- **Touch/No Touch, Ends Between/Outside**: realized-volatility regime
  (expanding vs contracting relative to its own baseline), with a barrier
  offset scaled to recent volatility.
- **High Tick/Low Tick**: momentum-implied pick of which of the next 5 ticks
  is the plausible extreme — the single weakest-evidence family here, since
  it's one tick pick rather than a distributional read.

Every signal carries a `family` tag alongside `contract_type`,
`duration_ticks` (auto-picked per signal — not fixed), an optional
`prediction`/barrier, `confidence`, and `basis`.

**Important:** Deriv's synthetic indices are independent random draws /
fair random-walk processes — past behaviour does not change the odds of the
next tick. These are statistical *deviation/momentum* signals, not
predictions or win-probability estimates. `signalHub.js` broadcasts every
update over `/ws/signals` to all connected frontends, throttled to ~2-3
updates/sec per symbol.

**Not yet covered:** Multiplier and Accumulators. Both are open-position
contracts (no fixed duration, actively closed or knocked out) rather than
the fixed-duration "settles after N ticks" shape every family above shares —
they need a different execution/monitoring model on the frontend before an
analysis model for them is useful, so they're a deliberate follow-up rather
than a gap that was missed.

## The AI auto-pilot

There is no backend "AI run" anymore — the frontend's auto-pilot
(`src/pages/bulk-trader/autoPilotEngine.ts`) reads the same `/ws/signals`
feed the Digit Matrix grid uses, picks the best signal across every
family above, and executes, watches, and martingale-recovers (flipping to
the opposite side of whichever family just lost, escalating stake) entirely
in the browser. This backend's only involvement is computing and
broadcasting the signals it was already broadcasting — nothing here starts,
stops, or tracks a trading run.

## Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness check; also reports whether Postgres logging is active and how many symbols are tracked |
| GET | `/api/analysis/symbols` | — | The list of tracked symbols |
| GET | `/api/analysis/snapshot` | — | Current stats + signals for every tracked symbol (REST fallback for the WS feed) |
| GET | `/api/analysis/snapshot/:symbol` | — | Current stats + signals for one symbol |
| GET | `/api/analysis/history/:symbol` | — | Recent stored signal snapshots for one symbol (`?limit=`, max 500). Empty array if no database is configured |
| WS | `/ws/signals` | — | Live push feed: full snapshot on connect, then throttled per-symbol updates as ticks arrive |

## Deploying to Render

1. Push this repo to GitHub (already done).
2. In Render: **New → Web Service**, connect the repo.
3. Set **Root Directory** to `backend`.
4. Build command: `npm install`. Start command: `npm start`.
5. Add environment variables (see `.env.example`):
   - `ALLOWED_ORIGIN` — your Vercel frontend URL, so only your site can call this API.
   - `DATABASE_URL` — optional, only if you want signal history persisted (see below).
   - `AI_AGENT_MAX_STAKE` — optional hard ceiling (default 25) on the `stake` a client can request in the AI config — this only affects what's *shown* as the suggested stake, since the backend never spends it.
6. Deploy. Copy the resulting `https://<your-service>.onrender.com` URL.
7. In Vercel, set `NEXT_PUBLIC_BULK_TRADER_API_URL` to that URL and redeploy
   the frontend. `NEXT_PUBLIC_ANALYSIS_WS_URL` is optional — it's derived
   automatically from the REST URL (`https→wss`, `+ /ws/signals`) if unset.
   Also set `NEXT_PUBLIC_DERIV_APP_ID` on the frontend to your registered
   Deriv app id (`34o9mFaY1HjSSSXyE5DuL`) — the frontend now talks to Deriv
   directly for trading, so it needs its own app id.

Alternatively, commit `render.yaml` (already included) and use Render's
"Blueprint" deploy option to provision it from this repo directly.

## Optional: persistence with Neon (or any Postgres)

Set `DATABASE_URL` and the backend automatically creates the
`signal_history` table and starts logging to it — no other code changes
needed. It's a snapshot of each symbol's stats + ranked signals every 30
seconds (throttled, not every tick), so you can look back at what the
"brain" was seeing at any point — e.g. to later check how well the
confidence score tracked what actually happened. Query it via
`GET /api/analysis/history/:symbol?limit=100`.

Without `DATABASE_URL` set, the backend works exactly the same — it just
doesn't keep history.

**Using [Neon](https://neon.tech)** (recommended — free tier, serverless
Postgres, scales to zero when idle):

1. Create a free Neon account and a new project.
2. In the project dashboard, go to **Connection Details** and copy the
   **pooled connection** string (looks like
   `postgresql://user:password@ep-xxxx-pooler.region.aws.neon.tech/dbname?sslmode=require`).
3. In Render, add it as the `DATABASE_URL` environment variable on the
   backend service, then redeploy (or just restart — Render picks up new
   env vars on the next deploy).
4. Check `GET /health` — `persistence` should be `true` once it connects.

Any other managed Postgres (Render Postgres, Supabase, RDS, etc.) works the
same way — just set `DATABASE_URL` to its connection string.

## Limitations / next steps

- The analysis window (last 500 ticks per symbol) is in-memory only and
  rebuilds from `ticks_history` a few seconds after every restart — it's
  meant to reflect *recent* market behaviour, not a permanent record.
- The AI scanner's run state is in memory too. If the Render instance
  restarts (e.g. free-tier spin-down), an active scan stops — the frontend's
  own execution/tracking is unaffected either way since it never depended on
  this service holding state about trades.
- Multiplier and Accumulators aren't covered yet — see the note above; they
  need an open-position execution model on the frontend before an analysis
  model for them is worth building.
- The 9 families' scoring is heuristic (momentum/streak/volatility
  statistics), not a backtested or validated trading strategy — it hasn't
  been run against live Deriv data yet, only synthetic price series in
  isolated tests.
- There's no authentication on the backend — it never sees anything
  sensitive, so CORS restricted to `ALLOWED_ORIGIN` is the only real
  boundary it needs.
