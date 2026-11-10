# Project memory: Digit X Matrix (read this first)

Where things stand (latest first). This file is the project's memory: Claude's own memory feature is off in Settings, so the progress is saved here and in FIXES-AND-SETUP.md.

## Latest build (pair mode: every trade is a pair fired together)
- New AI Trader checkbox **Fire in pairs** (`pair_mode`, on by default in the presets). Pairs: Only Ups + Only Downs, Even + Under 5, Odd + Over 4, Rise + Odd, Fall + Even (`PAIR_PARTNER` in `autoPilotEngine.ts`). The entry signal of one contract fires the pair on the same tick, market, stake and duration; the two results count as one trade (ladder, stop loss, take profit see the net). Rise fires Rise + Odd, Fall fires Fall + Even; Even / Odd signals fire Even + Under 5 / Odd + Over 4. Both contracts must be ticked or the signal is skipped. Only Ups / Downs keep the payout-covers-both-stakes check.
- Tests added in `__tests__/overlap-pairs.spec.ts` (pair mode block). NOT run here (no node_modules): run `npx jest` and `tsc` before relying on it.
- Logic test only: every contract pays under 2x, so pairs lose a little on average.

## Current state
- Frontend: Deriv Bot app + our tabs (Bulk Trades, AI Trader, Journal). Engine: `src/pages/bulk-trader/autoPilotEngine.ts` (runs in the browser).
- Backend (`backend/`, Render): market feed + 24/7 paper trader + signals + journal/learning endpoints.
- Safe 24h plan, quality gate, recovery stake (martingale that wins the ladder back), both sides for Only Ups/Downs, and ENTRIES FROM BACKEND SIGNALS (run bias: 3+ ticks in a row in favour of a contract). The virtual hook (paper trades) is REMOVED from the frontend and the backend (owner's decision: it delayed entries).

## Decisions made with the owner
- Over 4 / Under 5 and the switch pairs; Touch/No Touch barrier 0.5 (5 ticks, else 10); Higher/Lower 0.1 and multipliers live on the Bulk Trades tab.
- Trend contracts (Rise/Fall, Only Ups/Downs, Higher/Lower, multipliers) need higher highs / lower lows on the 1-tick chart.
- (Removed) Virtual hook: paper trades after a live loss decided the next live trade. Older asks, kept for history: opposite-of-lost-paper-trade idea, both sides after the hook (not Touch/No Touch), follow the tick stream, skip a contract when no entry is found, Only Ups + Only Downs both sides.
- AI tab explanations collapse behind an "i" icon; site must fit Android/iOS.
- Journal has a Clear button (browser copy only).

## Evidence to keep in mind (from the backend paper trader and the owner's CSVs)
- ~1M paper trades: every contract wins about 50% against ~55% needed; each loses roughly 8-10c per 1.00 staked. No timing rule found a real edge. Both-sides pairs (Even+Odd, Over 4+Under 5) lose a guaranteed slice; Only Ups + Only Downs usually both lose.
- Touch/No Touch at +0.5 pays only about 5% on a No Touch win.

## Latest build (no recovery ladder, next-tick buy, no Touch / No Touch)
- Owner removed the recovery ladder (it added delay) and Touch / No Touch from the AI; focus is Even/Odd, Over 4/Under 5, Rise/Fall, Only Ups/Only Downs. Buy happens on the next tick after the backend signal. The one-trade-a-minute gap in the earlier live results was `max_trades_per_hour: 60` in the preset (now 0).

## Previous build (per-contract run levels; Touch / No Touch focus)
- Even/Odd and Over 4/Under 5 fire on 2 AND 3 consecutive ticks; Only Ups/Downs from 2 ticks (both bought together, only if a win pays both stakes); Rise/Fall and Touch/No Touch from 2 ticks. Backend does all the analysis; the AI only executes entries.
- Owner's priority was Touch / No Touch first, but a live run lost on No Touch only (5 losses in a row, net -80.84, wins paying 6%). Now all families are ticked by default; Touch / No Touch needs >= 70% payout, recovery is sized on the real payout, ladders capped at 3 steps.

## Previous build (run bias + signal execution, virtual hook removed)
- Backend `backend/src/runBias.js`: for each market, how often 3+ ticks in a row favoured each contract (Even 2,4,6; Odd 1,3,7; Over 4 5,8,9; Under 5 2,1,4; Rise, Fall, Only Ups/Downs, Touch/No Touch). Bias % = a contract's share of all run ticks of its pair (50 balanced, higher = more favoured). An ENTRY signal (family `run_bias`, `entry: true`, `run_id`) is raised when the run is on now and the bias is >= 55.
- Frontend engine: polls the backend snapshot every 300 ms and buys the strongest entry signal at once (no paper test, no wait on its own tick stream); one run is traded once; Rise/Fall and Only Ups/Downs still need their 1-tick trend. After a loss the recovery stake goes on the next best signal across all ticked contracts.
- Removed: `paperTrader.js`, `/api/paper/stats`, `paperStats.ts`, `PaperLearningCard`, the virtual hook, follow-stream/entry-tick/entry-reader/rotate/auto-flip settings, their tests. The learner no longer uses paper evidence (edge gate uses the account's own trades only).
- Verified: pure backend check `npm run check:runbias`, snapshot smoke test with a stubbed feed; engine specs (signal-entry, recovery-and-reading, safe-plan, edge-gate, follow-stream, ai-trader-rules, one-second-only) pass in a small stand-in runner. Full `npx jest`, `tsc` of the whole app and a live Deriv run were NOT possible here: run them before relying on it.

## Earlier build (merged: keepalive + mobile-v17)
- Base is the keepalive build; the useful parts of mobile-v17 were merged in (see FIXES-AND-SETUP.md, top entry).
- Verified in this build: `tsc --noEmit` clean, `npx jest` 56 suites / 556 tests pass, backend `check:mcp`, `check:keepalive`, `check:pairs` pass. Not run against live Deriv.
- Render: service live on commit "melon ai" when last checked; the feed-drops-every-2-minutes fix (ping every 25s) is in this zip and not yet deployed.

## Open items
- Trading while the laptop/phone is closed needs a server-side runner with a Deriv trading token (design + security decision pending; cannot be tested without node_modules/Deriv).
- Layout on a real phone has not been seen by Claude (no browser available): check Journal / AI Trader / Bulk Trades on Android and iOS and report anything off.
