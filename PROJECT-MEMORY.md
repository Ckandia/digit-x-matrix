# Project memory: Digit X Matrix (read this first)

Where things stand (latest first). This file is the project's memory: Claude's own memory feature is off in Settings, so the progress is saved here and in FIXES-AND-SETUP.md.

## Basket with no wait (latest, Nov 2026)
- Basket buys on the digit-pair signal alone: no confirmed trend needed (`basket_direction` = trend, else last tick's move). Bias logic checked with a random property test. Details in FIXES-AND-SETUP.md. Backend must be redeployed.

## Digit frequency + fast entry rule
- **Digit frequency (backend `backend/src/digitFrequency.js`, part of every market's `run_bias.digits`):** for each of the five 1s markets, over the same 300-tick window: how often each digit 0-9 appeared, the 1st / 2nd / 3rd MOST frequent digit and the LEAST frequent digit (the 4 key digits; ties: most recent digit ranks higher, longest-unseen digit is the least). Shown on the AI tab in the new "Digit frequency" table above the run bias table.
- **Support:** the 3 most frequent digits support a contract when they belong to its digits (Even 0,2,4,6,8; Odd 1,3,5,7,9; Over 4 5-9; Under 5 0-4); the least frequent digit supports a contract when it is NOT one of its digits. **2 of the 4 is already a bias (owner's rule: do not wait for all 4).** A 2-2 tie with the opposite contract (Even/Odd, Over 4/Under 5) goes to the one whose digits filled more of the window; an exact tie favours neither. Strength % = 20 (2 digits) / 40 (3) / 60 (4) + 2 per % the contract's digits are above half the window, capped 100; it is the signal's confidence, so it clears the default minimum signal strength (20).
- **Fast entry rule (owner's request: stop the AI taking long to buy):** Even / Odd / Over 4 / Under 5 and every pair with a digit leg (Even+Under 5, Odd+Over 4, Even+Over 4, Odd+Under 5, Rise+Odd, Fall+Even) now fire on **2 consecutive ticks + the digit frequency favouring every digit leg**. No longer required for these: the 3-tick level (only the 2-tick level fires; a run keeps its id when it grows, so it is bought once), run bias >= 55, replayed hit rate / net, and for the 3-contract basket the third contract's own bias and the replayed basket result (a chart direction is still needed to pick the third contract; Rise+Odd / Fall+Even keep their 1-tick trend). Rise / Fall / Only Ups / Only Downs singles keep their old rules. `DIGIT_FREQ_GATE=off` (backend env) restores the old rules.
- **Expect more trades.** Looser entries = more buys on a random process; nothing here was validated as an edge, and the martingale amplifies bad runs. Test on a demo account.
- Checks: `npm run check:digits` (new), `check:runbias` (updated), `check:pairs`; engine specs overlap-pairs, pairs-only, loss-martingale, stay-on-market, basket, fast-entry passed in a jest stand-in runner. Full `npx jest`, `tsc` and a live Deriv run were NOT possible here. Deploy the backend (Render) for the new signals.

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

## Basket entry aligned with the contracts (latest)
- **What was misaligned:** the backend judged a basket signal only on its two digit contracts (an equal-stake pair replay). The third contract (Only Ups/Downs or Rise/Fall), the 40/40/20 or 35/35/30 stake split and the chart direction were never part of the entry, and the AI picked the third contract on its own.
- **Now (`backend/src/runBias.js`):** the four digit bases carry `basket_entry`. It is true only when ALL of these hold: (1) the digit-pair entry (fresh pattern, bias >= 55, digit legs not losing after it); (2) the chart has a direction, which picks the third contract; (3) that third contract has its own support (its run bias >= 55); (4) `replayBasket` replays the whole basket on this market's history (the chart direction and momentum AT each past pattern tick, the three contracts on their own exit ticks, stakes split by the shares) and with at least 10 replays it was not losing (avg net >= 0 per 1.00 total stake).
- **One table:** the signal names its setup (`basket_setup`, 1-16) and `basketFor` is the single definition. The AI builds the basket with its own table and refuses to buy if the numbers differ; a cross-check confirmed both tables agree on all 16 setups.
- **AI:** in basket mode it buys only signals with `basket_entry === true`.
- **Estimate to know about:** the replay needs a payout for Only Ups / Only Downs; I used `ONLY_RUN_PROFIT = 2.8` (about 0.95 / 0.25 - 1, a random-walk estimate). It only decides whether the replayed basket was above or below break-even, it never changes a stake. Replace it with Deriv's real payout if you have it.
- **Expect fewer entries** (in a random test about 6 in 10 digit-pair entries passed the basket check). Thresholds: `MIN_ENTRY_BIAS_EDGE`, `MIN_OUTCOME_SAMPLE`, `MOMENTUM_TICKS` in runBias.js. A scan costs about 1.4 ms at 300 ticks.
- Tests: `npm run check:runbias` (setups 1-16, replay on hand-made data, property check over 400 random markets) and `basket.spec.ts` (two new cases). All pass; the full jest suite, build and a live demo run still need doing on your side.

## Why the AI was not trading, and the fix (latest)
- **Most likely cause:** in basket mode the AI buys only signals the backend marks `basket_entry`. A backend that was not redeployed (the backend runs on Render, separately from the website) sends no such field, so every signal was skipped and the AI said nothing. I tested the other side: with signals produced by the NEW backend code the AI buys the basket correctly, and on simulated markets the new backend produced roughly 50-90 basket entries per market per hour (so the gates are not too strict). **Redeploy the `backend/` folder on Render, then restart the AI.** Check it: open `<your-backend>/health`, it must show `"basket_api": 2`.
- **No more silent AI:** in basket mode the AI now logs every 30 seconds why it is not buying (`basketDiagnosis`): an OLD backend (red error), no digit-pair signals at all, a quiet market, or how many entries were dropped for no chart direction / no support for the third contract / a losing replayed basket / below the minimum signal strength / an unticked base, and, after a loss, that it is waiting on the same market and pair. Tests in `basket.spec.ts`.
