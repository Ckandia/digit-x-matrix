# Claude connector: let Claude read your trades

A read-only MCP server on your Render backend. Claude can summarise your results, list trades, break them down by
market / contract / stake step / hour, and analyse how your losing runs end. It cannot place, change or cancel a trade,
and it never sees your Deriv token.

## How it works
App (browser) --pushes settled trades--> Render backend (`/api/journal/ingest`) <--reads-- Claude (`/mcp/<MCP_SECRET>`)

Your trades live in the browser, so the app has to push them. Trades are kept 24 hours (Postgres if `DATABASE_URL` is
set, otherwise memory, which is also lost when Render's free tier sleeps). 24 hours follows the Deriv API Terms caching
limit that `signal_history` already obeys. For longer history, export the CSV from the Journal tab.

## Setup (once)
1. Deploy the backend to Render (`backend/render.yaml`). It creates `MCP_SECRET` and `JOURNAL_SYNC_KEY` for you; copy both from the service's **Environment** tab. (Or set your own: MCP_SECRET 24+ chars, JOURNAL_SYNC_KEY 16+ chars.)
2. In the app: **Journal tab > Claude connector**. Paste the sync key, click **Save key**, tick **Send my trades to the Claude connector**. `NEXT_PUBLIC_BULK_TRADER_API_URL` must point to the backend (it already does if signals work).
3. In Claude: **Settings > Connectors > Add custom connector**. URL: `https://<your-service>.onrender.com/mcp/<MCP_SECRET>`. Name it e.g. "Digit X trades".
4. Ask Claude: "Check my trade data status, then tell me why my balance is falling."

## Tools
| Tool | What it gives |
|---|---|
| `get_data_status` | how many trades, accounts, newest/oldest, retention, storage |
| `get_trade_summary` | win rate vs break-even win rate, profit, ROI, profit factor, longest losing streak, max drawdown |
| `list_trades` | individual trades (filter by account, market, contract, source, win/loss) |
| `get_breakdown` | results grouped by symbol, type, source, account, step, tag, strategy or hour (UTC) |
| `analyze_recovery` | loss cycles, how many recovered, worst cycle, max stake vs base, results per ladder step |

## Security notes
- The secret in the URL is the credential: anyone with the URL can read your trade results. Keep it private. To rotate, change `MCP_SECRET` on Render and update the connector.
- Unknown or wrong secrets get a 404, so the endpoint does not reveal itself.
- Clients that can send headers may use `https://<service>.onrender.com/mcp` with `Authorization: Bearer <MCP_SECRET>`.
- Every field of an incoming trade is whitelisted; anything else (including a token) is dropped.
- This is secret-in-URL auth, not OAuth. If you need per-user sign-in, that is a bigger build.

## Checks
`cd backend && npm run check:mcp` runs the connector end to end with a real MCP client (auth, ingest, all five tools).
