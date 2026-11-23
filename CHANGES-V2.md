# V2: market-aware basket selection + directional contract fix

Built on the previous zip (`digit-x-matrix-single.zip`). Nothing was rebuilt; only the logic below changed.

## 1. Weaknesses found in the code before changing it
1. **The third contract was invented.** With no confirmed trend the backend used the last tick's move, and with no move at all "bullish". Strong momentum only needed a trend plus 3 ticks, not 4 of the last 5.
2. **The basket was not all-or-nothing.** The AI sent its buys directly and in parallel with no pricing step, so a refusal on one leg after the others went through left a partial basket. The old pair path had a pricing step, the basket did not.
3. **The frontend could reinterpret the signal.** It fell back to the `trend` field when `basket_direction` was missing and accepted a signal with no `basket_setup`.
4. **No per-signal explanation.** Nothing recorded digits, key digits, support, direction class, last 5 moves or the setup for a bought or rejected signal.
5. Verified, not a bug: the digit calculation (ranking, recency tie-break, least-digit tie-break, support, favoured, share tie-break, 300-tick window, strength) was already correct. It now has tests against your snapshot.

## 2. Files changed
- `backend/src/runBias.js`: `classifyDirection`, `buildAudit`, direction used by the pair and single-contract paths; `basketDirection` (last-tick fallback) removed.
- `backend/src/digitFrequency.js`: `ranked` in the result; new `preferredBase()`. The calculation itself is untouched.
- `src/pages/bulk-trader/autoPilotEngine.ts`: backend-only direction and setup, proposals-first purchase, audit logging, rejected-signal logging.
- `src/pages/bulk-trader/AiAgentPanel.tsx`: explanation text.
- Tests: `backend/test/digitFrequency.check.mjs`, `backend/test/runBias.check.mjs`, `src/pages/bulk-trader/__tests__/basket.spec.ts`.
- Docs: this file, `docs/BUY-LOGIC-PROMPT.md`, `FIXES-AND-SETUP.md`, `PROJECT-MEMORY.md`.

## 3. Logic changed
**Direction of the third contract** (`classifyDirection`, backend only). Inputs: the existing trend detector (swings over the last 60 ticks) and the last 5 NON-FLAT price moves (flat ticks ignored).

| Class | Conditions | Contract |
|---|---|---|
| strong bullish | trend bullish AND last 3 moves up AND at least 4 of last 5 up | Only Ups (2 ticks), momentum |
| strong bearish | trend bearish AND last 3 down AND at least 4 of last 5 down | Only Downs (2 ticks), momentum |
| moderate bullish | trend bullish AND at least 3 of last 5 up AND not strong AND the last 2 moves are not both down | Rise, drift |
| moderate bearish | trend bearish AND at least 3 of last 5 down AND not strong AND the last 2 moves are not both up | Fall, drift |
| none | no confirmed trend, trend conflicts with the moves, or fewer than 5 non-flat moves | NO DIRECTION: no basket |

- Strong beats moderate. One trend decides the side, so a bullish reading can never pick a bearish contract and the reverse.
- "Recent moves do not contradict the trend" is implemented as: the last two moves are not both against the trend. Your spec did not define it further, so this is my reading; change it in one place (`classifyDirection`).
- Rise / Fall keep their existing durations. Only Ups / Downs keep 2 ticks.

**Base selection.** `preferredBase()` = the favoured one of Even/Odd + the favoured one of Over 4/Under 5, recalculated live per market. The single-contract path now requires the trigger contract to belong to that base. The full-pair path is unchanged (both digit legs have a 2-tick run and both are favoured), and it still takes priority over the single path. Nothing is hard-coded per market.

**Purchase is all-or-nothing.** Every contract in the basket is priced first (all proposals at once). All buys are sent in the same tick only if every proposal is present, its ask price is no higher than its stake (+0.01), it pays more than it costs, and the signal is still younger than 1.5 s. Otherwise nothing is bought, the rejection is logged and the run is not replayed. Residual risk: after valid quotes, a buy can still be refused. That is reported as "Atomic purchase result: n of m" and the legs that did go through are tracked as before.

**Frontend never reinterprets.** It buys only when the backend sends `basket_entry`, a `basket_direction` and an integer `basket_setup`; the AI builds the same setup or buys nothing. A market mismatch with the audit record also stops the buy.

**Logging.** For every basket signal the AI logs (3 lines): market, sample size, digit counts and shares, ranking, key digits; support, favoured contracts, strengths, current runs, run bias; trigger, path (single/full pair), base and the reason, trend, last 5 non-flat moves, direction class, third contract, regime, setup number, stake shares. Then the proposals and prices, validation result and the atomic purchase result. Rejected signals (including NO DIRECTION and its reason) are logged once per run.

## 4. Logic preserved (verified)
- The stake ladder, multiplier, max steps, reset, partial-loss and win behaviour: `_basketNext` and `_holdMarket` are byte-identical to the previous version; the loss-martingale, stay-on-market, market-switch and safe-plan specs pass unchanged.
- Base stake, minimum 0.35 per leg and automatic total-stake adjustment, stake shares 40/40/20 and 35/35/30, balance checks, capital protection, stop loss, take profit, DEMO/REAL, trade history and settlement.
- Optional cover (off by default, unchanged), latency guard 500 ms, signal age 1.5 s, polling 100 ms, max trades per hour, duplicate-run prevention, basket-mode bypass of the self-review skip list, Touch / No Touch untraded.
- MIN_RUN = 2, no 3-tick requirement, no virtual hook, no entry-run wait, no replayed hit-rate requirement.
- Only Ups and Only Downs remain enabled and supported (setups 1, 2, 5, 6, 9, 10, 13, 14).

## 5. Run bias and two-tick table: what they are (confirmed in the code)
- **Run bias** (`backend/src/runBias.js`): for a contract, the ticks that sit inside runs of at least 2 ticks that favour it, divided by (those + the same for its opposite), x 100, over the last 300 ticks of that market. The number next to a contract in a report that is not a percentage is the current run length (`current`). It is secondary information only: it does not trigger or select anything in the fast rule.
- **Two-tick table** (`backend/src/pairScan.js`): % of three-price windows (entry, then 2 ticks) that show each pattern, over the market feed's 500-tick buffer = 498 windows. It is a different, larger sample than the 300-tick digit window and overlaps it. The two are never combined. Touch / No Touch appear there for information only.

## 6. The 16 setups (the same table in backend `basketFor` and frontend `basketSetup`, compared by a test)
| # | Base | Third contract |
|---|---|---|
| 1 / 2 | Even + Under 5 | Only Ups / Only Downs (momentum) |
| 3 / 4 | Even + Under 5 | Rise / Fall (drift) |
| 5 / 6 | Odd + Over 4 | Only Ups / Only Downs |
| 7 / 8 | Odd + Over 4 | Rise / Fall |
| 9 / 10 | Even + Over 4 | Only Ups / Only Downs |
| 11 / 12 | Even + Over 4 | Rise / Fall |
| 13 / 14 | Odd + Under 5 | Only Ups / Only Downs |
| 15 / 16 | Odd + Under 5 | Rise / Fall |

Number = base index x 4 + 1 + (drift ? 2 : 0) + (bearish ? 1 : 0).

## 7. Tests run (with a small Jest stand-in and Node; the full Jest, `tsc` and build were not available here)
- `basket.spec.ts`: 45 passed, 0 failed. New: all-or-nothing (each of 3 proposals missing or invalid, price too high, payout too low, expired signal, market mismatch, balance), NO DIRECTION rejected once and not replayed, old backend buys nothing, audit logged, 16 setups identical to the backend.
- `digitFrequency.check.mjs`: passed. Your 5-market snapshot rebuilt as 300-tick windows reproduces every support, share and strength figure and selects V10 Even+Over 4, V25 Odd+Under 5, V50 Odd+Under 5, V75 Even+Over 4, V100 Even+Under 5; direction classes (strong, moderate, none, conflicts, flat ticks, insufficient data); random check over 3000 windows.
- `runBias.check.mjs`, `pairScan.check.mjs`: passed. All other specs in `__tests__` pass (17 files).
- Failed tests: none. Not run: the Journal specs and `ai-runtime.spec.tsx` (they need packages that are not installed here), the production build, a live Deriv session.

## 8. Remaining limitations and what was NOT changed
- With the strict direction rule a basket needs a confirmed trend, so baskets fire far less often than in the previous version. That is the intended effect of your spec.
- The signal age is measured from when the AI first sees a signal; the backend's audit timestamp is logged but not compared, to avoid clock-skew false rejections.
- Not changed: stake ladder, stake shares, minimum stake, cover, atomic flow for the old pair paths, latency guard, WebSocket protocol, Bulk Trades tab, Journal, DEMO/REAL, the digit calculation, MIN_RUN.
- No performance claim is made. Every contract has a negative expected value.

## 9. Run in DEMO
1. Deploy the backend (Render) from this zip, then the frontend.
2. Log in with a DEMO account; AI tab; 3-contract basket on; keep the stake small.
3. Start. The activity log shows the 3-line signal record, the proposals and the atomic result; NO DIRECTION lines show why a signal was rejected.
