# Project memory: Digit X Matrix (read this first)

Where things stand (latest first). This file is the project's memory: Claude's own memory feature is off in Settings, so the progress is saved here and in FIXES-AND-SETUP.md.

## Current state
- Frontend: Deriv Bot app + our tabs (Bulk Trades, AI Trader, Journal). Engine: `src/pages/bulk-trader/autoPilotEngine.ts` (runs in the browser).
- Backend (`backend/`, Render): market feed + 24/7 paper trader + signals + journal/learning endpoints.
- Safe 24h plan, quality gate, virtual hook (paper-trade after a loss), two-tick entry (buy on the 3rd matching tick), follow-the-stream rule, recovery ladder.

## Decisions made with the owner
- Over 4 / Under 5 and the switch pairs; Touch/No Touch barrier 0.5 (5 ticks, else 10); Higher/Lower 0.1 and multipliers live on the Bulk Trades tab.
- Trend contracts (Rise/Fall, Only Ups/Downs, Higher/Lower, multipliers) need higher highs / lower lows on the 1-tick chart.
- Virtual hook: paper trades after a live loss decide the next live trade. Latest asks: opposite-of-lost-paper-trade idea, both sides after the hook (not Touch/No Touch), follow the tick stream, skip a contract when no entry is found, Only Ups + Only Downs both sides.
- AI tab explanations collapse behind an "i" icon; site must fit Android/iOS.
- Journal has a Clear button (browser copy only).

## Evidence to keep in mind (from the backend paper trader and the owner's CSVs)
- ~1M paper trades: every contract wins about 50% against ~55% needed; each loses roughly 8-10c per 1.00 staked. No timing rule found a real edge. Both-sides pairs (Even+Odd, Over 4+Under 5) lose a guaranteed slice; Only Ups + Only Downs usually both lose.
- Touch/No Touch at +0.5 pays only about 5% on a No Touch win.

## Latest build (market bias + server runner, October 2026)
- **Market bias (run scan):** `backend/src/runScan.js` counts, per market, the three-tick windows in which all three ticks favoured Even (2,4,6), Odd (1,3,7), Over 4 (5,8,9), Under 5 (2,1,4), Rise or Fall (Only Up/Down use the same runs). Reported as % of windows vs a fair market, z-score, runs, longest run and the run in progress. Comes with every snapshot (`runs`), `GET /api/analysis/runs`, a "Market bias" card on the AI tab, and the entry reader uses it as a small tie-break between equally ready entries. It describes the stream, not the next tick; about 1 cell in 12 is green by chance. Touch/No Touch are not scanned (no per-tick rule). Check: `cd backend && npm run check:runs`.
- **Server runner (keeps trading when closed):** compiled engine in `backend/src/runner/engine` (`npm run build:runner`, `npm run check:runner-build`), `backend/src/runner/runnerService.js`, endpoints `/api/runner/*` (need `RUNNER_KEY`), AI-tab switch. Uses a Deriv API token the owner creates (Read + Trade), memory only; the website's login token is NOT used. Tested with a fake connection (`npm run check:runner`), never against live Deriv: try on a DEMO account first.

## Previous build (merged: keepalive + mobile-v17)
- Base is the keepalive build; the useful parts of mobile-v17 were merged in (see FIXES-AND-SETUP.md, top entry).
- Verified in this build: `tsc --noEmit` clean, `npx jest` 56 suites / 556 tests pass, backend `check:mcp`, `check:keepalive`, `check:pairs` pass. Not run against live Deriv.
- Render: service live on commit "melon ai" when last checked; the feed-drops-every-2-minutes fix (ping every 25s) is in this zip and not yet deployed.

## Open items
- The server runner is built (see above) but unproven against live Deriv: the login-URL call with a personal API token (and whether Deriv wants the app id header, sent when DERIV_APP_ID is set) must be tried on a demo account. A sleeping free Render instance stops the run.
- Layout on a real phone has not been seen by Claude (no browser available): check Journal / AI Trader / Bulk Trades on Android and iOS and report anything off.
