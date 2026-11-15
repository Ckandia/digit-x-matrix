# Project memory: Digit X Matrix (read this first)

Where things stand (latest first). This file is the project's memory: Claude's own memory feature is off in Settings, so the progress is saved here and in FIXES-AND-SETUP.md.

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


## Pairs only, loss-only martingale, entry quality gate (latest)
- **Pairs only (default on, AI tab checkbox):** the AI buys nothing but five pairs, both legs on the same tick, same stake each, counted as ONE trade: Only Ups + Only Downs, Even + Under 5, Odd + Over 4, Rise + Odd, Fall + Even. Each pair can be ticked off. A single contract is never bought in this mode; if the second leg cannot be built nothing is bought, and a balance under two stakes stops the run. In this mode Only Ups + Only Downs fires without the old payout-cover check (your request). Off = the older single-contract behaviour.
- **New backend pairs:** `rise_odd` (price up AND odd digit on the same tick, needs a bullish 1-tick trend) and `fall_even` (price down AND even digit, needs bearish), added in `backend/src/runBias.js` with the same replay/bias/freshness rules as Even + Under 5. Pair signals now carry `pair_key`.
- **Martingale on loss only (default, 1.5x):** after a loss the next stake (per leg for a pair) = last stake x `martingale_multiplier` (1.5), up to `max_steps` losses, then back to base; a win ALWAYS goes back to the base stake and never raises it. A stake the stop loss no longer allows resets to base. Modes: martingale (default), reverse, flat.
- **Entry quality gate:** `min_confidence` (default 20 = measured hit rate >= 60%, UI field "Minimum signal strength"). Weaker signals are skipped and the strongest signal across markets goes first. This picks the best measured moment; it cannot make a tick predictable. A martingale and two-leg pairs do not create an edge, they change how fast a bad run loses.
- Tests: `pairs-only.spec.ts`, `loss-martingale.spec.ts`, `npm run check:runbias` (cross pairs). Passed under a jest shim; full `npx jest`, `tsc` and a live Deriv run were not possible here. Run `npm install && npx jest && npm run build` first, and test on a demo account.

## Recover on the same market (latest)
- **Why losses moved markets:** the AI ranked entries by "market traded least recently first", so right after a trade it preferred ANOTHER market and often another contract. A loss was never recovered where it happened.
- **Now (preset default, AI tab checkbox "After a loss, recover on the same market and pair"):** after a loss the AI only buys the SAME market and the SAME pair/contract (the pair key, or the contract type for a single). It switches market only when one condition is met: (1) `switch_after_losses` losses in a row on that market (default 2), or (2) `switch_wait_seconds` (default 45) passed after the loss with no new entry on that market and pair. A win frees it to take the best entry on any market again; a full martingale ladder also releases it. The stake ladder (x1.5) keeps going across a switch.
- Off = the old behaviour. Test: `stay-on-market.spec.ts` (7 cases) passes in the jest shim; run the full suite and test on demo first. This removes a cause of scattered trades; it does not make a tick predictable.

## 3-contract basket + 16 setups (latest)
- **One signal = 3 buys in the same tick** (`Promise.all`, `_enterBasket` in `autoPilotEngine.ts`). Each buy is wrapped so a refusal of one comes back as a value instead of rejecting the whole `Promise.all`: a contract that did get bought is never left unwatched (the basket then runs with the legs that went through, logged). Contracts that cancel each other (Even+Odd, Rise+Fall, Over 4+Under 5, Only Ups+Only Downs, Rise+Only Downs, Fall+Only Ups) can never be in one basket (`basketHasConflict`).
- **Bases (backend digit-pair signals):** A Even+Under 5 (blind 5,7,9), B Odd+Over 4 (blind 0,2,4), C Even+Over 4 (blind 1,3, new backend pair `even_over4`, both legs win on 6,8), D Odd+Under 5 (blind 6,8, new `odd_under5`, both win on 1,3).
- **Third contract:** the backend signal now carries `trend` (bullish/bearish/none on the 1-tick chart) and `momentum` (the last 3 ticks all went the trend's way). Momentum = Only Ups (bullish) / Only Downs (bearish), 2 ticks, stakes 40/40/20; otherwise drift = Rise / Fall, 1 tick, stakes 35/35/30. No chart direction (`none`) = no basket. **The momentum/drift split is my definition (3 ticks, `MOMENTUM_TICKS` in `backend/src/runBias.js`); change it there if you mean something else.**
- **Setups 1-16:** A = 1-4, B = 5-8, C = 9-12, D = 13-16, each in the order bullish momentum, bearish momentum, bullish drift, bearish drift (`basketSetup`). The AI tab has a checkbox plus the four bases; it is on by default and overrides Pairs only / contract families.
- **Stake:** `stake` is the TOTAL of the three. Split to the cent (the last leg takes the rounding remainder). Deriv's minimum is 0.35 per contract, so the total is raised to 1.75 (20% leg) or 1.17 (30% leg) when the base is smaller; it is logged.
- **Martingale state machine (`_basketNext`):** all contracts return 0 = total x1.5 (`martingale_multiplier`); some pay back but the net is negative = same total (flat); net >= 0 = back to the base total. Two safety limits I kept from before, not in your spec: a full-sweep ladder is capped at `max_steps` and the next total may not pass what the stop loss still allows (both reset to base). A net loss also recovers on the same market and pair (stay-on-market).
- Tests: `basket.spec.ts` (setups 1-16, stakes, simultaneity, partial refusal, state machine); the backend check covers the new pairs and regime fields. Passed under a jest shim and `tsc` on the engine file; run the full suite, build and a demo account first.
