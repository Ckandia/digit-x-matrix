# Digit X Matrix — Backend

A small Node/Express service with two jobs:

1. **The "brain"** — a always-on, unauthenticated feed of Deriv ticks for
   every digit-contract symbol, turned into rolling statistics and
   confidence-scored signals. This powers the digit grid, history matrix and
   "SIGNAL … ENTER NOW" banner on the **Bulk Trades** tab.
2. **The trader** — runs multiple digit-contract trading strategies
   concurrently against the Deriv API, on behalf of one account, when the
   user actually starts a bulk run. Nothing here places a trade on its own —
   every run is started explicitly from the frontend, by the account holder.

## Why a separate backend?

The frontend's bot engine (Deriv's Blockly-based `bot-skeleton`) is a
singleton — it's built to run one strategy at a time in the browser. Running
several strategies *truly* concurrently, independent of the browser tab
staying open, needs a server-side process. The live analysis feed also needs
somewhere to keep computing 24/7 even while nobody has the app open, so the
digit grid isn't empty on the next page load. That's this service.

## The analysis "brain"

`marketFeed.js` opens **one public (no token, no login) WebSocket** to Deriv
on boot and subscribes to ticks for 10 volatility-index symbols. Each new
tick's last digit is pushed into a rolling window (`digitAnalysis.js`,
500 ticks by default) and turned into:

- Per-digit frequency (0-9), hot/cold digit, even/odd + over/under splits,
  trailing streaks.
- A ranked list of **signals** — one per digit contract family
  (Even/Odd, Over/Under 5, Differs on the hottest digit, Matches on the
  coldest) — each with a 0-100 **confidence** score based on how far the
  observed frequency has drifted from its fair-RNG baseline, scaled by
  sample size.

**Important:** Deriv's synthetic indices are independent random draws —
past digit frequency does not change the odds of the next tick. These are
statistical *deviation* signals, not predictions, and the frontend labels
them that way. `signalHub.js` broadcasts every update over `/ws/signals` to
all connected frontends, throttled to ~2-3 updates/sec per symbol.

## The trader

1. `POST /api/bulk/start` opens **one** authorized WebSocket connection to
   Deriv for the account (using the token you send), then starts one
   `StrategyEngine` per strategy you configured, all sharing that connection.
2. Each `StrategyEngine` places a real contract (`buy`), watches
   `proposal_open_contract` until it settles, applies your chosen money
   management rule (flat / martingale / d'Alembert), optional Auto Flip
   (switches Even↔Odd or Over↔Under after a loss), checks your stop
   conditions (take profit / stop loss / max trades), and — if still
   running — places the next contract.
3. The frontend polls `GET /api/bulk/status/:run_id` every few seconds to
   show live results, and calls `POST /api/bulk/stop` to stop one or all
   strategies.

**The account token is only ever held in memory for the lifetime of the run.**
It is never written to disk or to the database.

## Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness check; also reports whether Postgres logging is active and how many symbols are tracked |
| GET | `/api/analysis/symbols` | — | The list of tracked symbols |
| GET | `/api/analysis/snapshot` | — | Current stats + signals for every tracked symbol (REST fallback for the WS feed) |
| GET | `/api/analysis/snapshot/:symbol` | — | Current stats + signals for one symbol |
| GET | `/api/analysis/history/:symbol` | — | Recent stored signal snapshots for one symbol (`?limit=`, max 500). Empty array if no database is configured |
| WS | `/ws/signals` | — | Live push feed: full snapshot on connect, then throttled per-symbol updates as ticks arrive |
| POST | `/api/bulk/start` | `{ token, strategies: [...] }` | Authorizes and starts up to 5 concurrent strategies |
| GET | `/api/bulk/status/:run_id` | — | Current status/stats for every strategy in the run |
| POST | `/api/bulk/stop` | `{ run_id, strategy_id? }` | Stops one strategy, or all of them if `strategy_id` is omitted |

## Deploying to Render

1. Push this repo to GitHub (already done).
2. In Render: **New → Web Service**, connect the repo.
3. Set **Root Directory** to `backend`.
4. Build command: `npm install`. Start command: `npm start`.
5. Add environment variables (see `.env.example`):
   - `DERIV_APP_ID` — your registered Deriv app id (`34o9mFaY1HjSSSXyE5DuL`).
   - `ALLOWED_ORIGIN` — your Vercel frontend URL, so only your site can call this API.
   - `DATABASE_URL` — optional, only if you want run history persisted (see below).
6. Deploy. Copy the resulting `https://<your-service>.onrender.com` URL.
7. In Vercel, set `NEXT_PUBLIC_BULK_TRADER_API_URL` to that URL and redeploy
   the frontend. `NEXT_PUBLIC_ANALYSIS_WS_URL` is optional — it's derived
   automatically from the REST URL (`https→wss`, `+ /ws/signals`) if unset.

Alternatively, commit `render.yaml` (already included) and use Render's
"Blueprint" deploy option to provision it from this repo directly.

## Optional: persistence with Neon (or any Postgres)

Set `DATABASE_URL` and the backend automatically creates two tables and
starts logging to them — no other code changes needed:

- **`bulk_runs`** — one row per bulk-trading run: start/end time, total
  profit, and a JSON summary of every strategy in it.
- **`signal_history`** — a snapshot of each symbol's stats + ranked signals
  every 30 seconds (throttled, not every tick), so you can look back at what
  the "brain" was seeing at any point — e.g. to later check how well the
  confidence score tracked what actually happened. Query it via
  `GET /api/analysis/history/:symbol?limit=100`.

Without `DATABASE_URL` set, the backend works exactly the same — it just
doesn't keep either kind of history.

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
- Runs are stored in memory. If the Render instance restarts (e.g. free-tier
  spin-down), any active runs are lost — strategies will stop, but no
  partially-placed contract is left dangling since each contract is bought
  and settled independently.
- Only digit contracts (Differs/Matches/Over/Under/Even/Odd) are supported —
  matching the "Digit X Matrix" concept. Extending to other contract types
  (Rise/Fall, Touch/No Touch, etc.) is a matter of adding them to
  `NEEDS_BARRIER` / the frontend's contract type list.
- There's no authentication on the backend beyond the Deriv token itself and
  CORS restricted to `ALLOWED_ORIGIN`. If you want to expose this beyond your
  own use, add a login layer in front of it.
