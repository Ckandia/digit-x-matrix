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

## Latest build (merged: keepalive + mobile-v17)
- Base is the keepalive build; the useful parts of mobile-v17 were merged in (see FIXES-AND-SETUP.md, top entry).
- Verified in this build: `tsc --noEmit` clean, `npx jest` 56 suites / 556 tests pass, backend `check:mcp`, `check:keepalive`, `check:pairs` pass. Not run against live Deriv.
- Render: service live on commit "melon ai" when last checked; the feed-drops-every-2-minutes fix (ping every 25s) is in this zip and not yet deployed.

## Open items
- Trading while the laptop/phone is closed needs a server-side runner with a Deriv trading token (design + security decision pending; cannot be tested without node_modules/Deriv).
- Layout on a real phone has not been seen by Claude (no browser available): check Journal / AI Trader / Bulk Trades on Android and iOS and report anything off.
