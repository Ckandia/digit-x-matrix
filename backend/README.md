# Digit X Matrix — Bulk Trader Backend

A small Node/Express service that runs multiple digit-contract trading
strategies concurrently against the Deriv API on behalf of one account. This
is what powers the **Bulk Trader** tab in the frontend.

## Why a separate backend?

The frontend's bot engine (Deriv's Blockly-based `bot-skeleton`) is a
singleton — it's built to run one strategy at a time in the browser. Running
several strategies *truly* concurrently, independent of the browser tab
staying open, needs a server-side process. That's this service.

## How it works

1. `POST /api/bulk/start` opens **one** authorized WebSocket connection to
   Deriv for the account (using the token you send), then starts one
   `StrategyEngine` per strategy you configured, all sharing that connection.
2. Each `StrategyEngine` places a real contract (`buy`), watches
   `proposal_open_contract` until it settles, applies your chosen money
   management rule (flat / martingale / d'Alembert), checks your stop
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
| GET | `/health` | — | Liveness check; also reports whether Postgres logging is active |
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
7. In Vercel, set `NEXT_PUBLIC_BULK_TRADER_API_URL` to that URL and redeploy the frontend.

Alternatively, commit `render.yaml` (already included) and use Render's
"Blueprint" deploy option to provision it from this repo directly.

## Optional: run-history persistence

If you attach a Postgres database (Render offers free/managed Postgres) and
set `DATABASE_URL`, the backend will automatically create a `bulk_runs` table
and log a summary (start time, end time, total profit, per-strategy results)
for every run. Without `DATABASE_URL` set, the backend works exactly the
same — it just doesn't keep history after a run ends.

## Limitations / next steps

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
