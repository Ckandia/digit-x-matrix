# AI learning layer

**What the AI already did:** read your balance and set stake as a % of it (risk preset), picked the market and contract with the highest signal score, auto-picked a tick duration, and recovered losses with a martingale that flips to the opposite side. It had no memory: every session started from zero.

**What this adds (learning):**
- `src/pages/bulk-trader/learningEngine.ts` records every settled trade per market + contract + duration (1, 2, 5 ticks etc.) and compares its win rate to the break-even rate implied by the real payout.
- It uses that to choose the market, contract and time frame (untried ones get explored, proven ones get preferred).
- Modes in the panel: **Learn** (explore with stakes capped at 25% of base until a combination has 20 trades), **Only trade a proven edge** (needs 30+ trades and a 97.5% lower bound above break-even), **Off**.
- Recovery ladder now stops if the whole ladder would exceed the stop-loss amount.
- `backend/src/learning.js` + `POST /api/learning/outcome`, `GET /api/learning/stats/:profile` keep the results in Neon (table `learning_stats`, created automatically) so learning survives browser clears and Render restarts. Without `DATABASE_URL` it falls back to memory and the browser copy.

**Privacy / Deriv terms:** only aggregate win/loss/stake/profit counts are stored, keyed by a hash of the login id. No ticks or digit data. Re-check clause 2 of Deriv's API terms if you want to keep these long term.

**Important:** synthetic indices are fair random processes. Learning measures whether anything beats break-even; it cannot create an edge, and martingale does not change the expected result, it only raises the size of a bad run. Test on a demo account. Not run against a live Deriv account or built/type-checked here (no network); run `npm run type-check` and `npm run build` before deploying.

**Deploy:** push, redeploy Render (no new env vars) and Vercel. Check `/health` shows `persistence: true` for Neon.

## Strategy Lab (added)
- `strategyLab.ts`: the "AI: set take profit / stop loss and test" button. It sets limits from evidence (no proven edge -> SL at 1/4 of your cap and TP equal to SL; proven edge -> full cap with TP at 1.5x), never above the cap from your risk preset.
- It then replays 3,000 simulated sessions per learned market/contract/time frame using your observed win rate and payout, and shows TP-hit vs SL-hit vs average result. "More TP than SL hits but still losing" is flagged, because tiny TP with big SL always looks good on hit rate.
- Combine with "Only trade a proven edge" so live trading waits for statistical proof.

## Results in Summary / Transactions / Journal (added)
Every AI trade now appears in the left-hand run panel tabs: contracts in Transactions (grouped under an `ai-<time>` run), totals in Summary, and each buy/win/loss/stop/error line in Journal.

## "Trading is not offered for this duration"
The Journal error now names the contract, market and duration, plus Deriv's own wording. With learning on, that combination is skipped for 6 hours and another is tried instead of stopping. With learning Off it still stops, but tells you which one failed.
If it keeps happening for a contract, fix the allowed list `allowedDurations()` in `learningEngine.ts` for that contract.
Errors elsewhere: read the Journal first (red lines), then the browser console, then Render logs for backend calls (`/api/learning/*`).

## AI Trader tab results (added)
The AI Trader tab now has its own "AI trade results" section (stays after a run stops): every trade with time, market, contract, ticks, stake and P/L, running win/loss/net totals, and an "Activity and errors" log (errors in red, including which duration Deriv refused). "Clear" empties it. The same trades also go to the left run panel (Summary, Transactions, Journal).
Files: `tradeHistory.ts`, `AiAgentPanel.tsx`, `ai-agent-panel.scss`.

## Bulk Trader tab results (added)
Same treatment as the AI Trader: a persistent "Bulk trade results" section (`TradeResults.tsx`) with every trade (time, market, contract, ticks, stake, P/L), win/loss/net totals and an "Activity and errors" log that names the failing contract/market/duration. It stays after a run stops and survives switching tabs (`tradeBus.ts`). Trades also feed the left panel Summary, Transactions and Journal.
Previously an engine error (e.g. a refused duration) silently hid the table; it is now logged.

## Run panel on the AI Trader tab (fix)
The Summary / Transactions / Journal tray is hidden by `show_run_panel` in `src/components/run-panel/run-panel.tsx` on any tab not in its list. Bulk Trades had been added earlier; AI Trader was missing, so the tray only appeared on Bulk Trades. AI_TRADER is now in the list.

## Contract rules + percentage-guided learning (added)
- `contractRules.ts` documents how each contract works in ticks and holds a built-in duration table (Ends Between/Outside = not offered in ticks, so the AI no longer picks it; Only Ups/Downs 2-5; Asians 5-10; digits 1-10; High/Low Tick fixed 5).
- The backend now asks Deriv what is really offered per market (`GET /api/contracts/:symbol`, cached 6h) and the AI uses that live answer over the built-in table. If Deriv doesn't answer, the built-in table is used, and any refused duration is still skipped for 6h.
- The backend collects ticks itself (public feed, 500-tick window) and now also reports the last 25/50/100 ticks (even/odd/over/under %). For digit contracts the AI records results per skew bucket of the last 50 ticks (min <50%, flat 50-60, lean 60-70, strong 70+; stored as e.g. DIGITEVEN@strong), so it finds out from real results whether following or fading a skew pays. The percentages describe what happened; they do not predict the next digit, and the learner will say so if they don't pay.
- Redeploy the backend (Render) as well as the frontend. Still to do: Only Ups/Downs both-side option, auto-flip as a selectable recovery mode, small-balance stake handling, cooldown / daily-limit / journal CSV.

## Connection, phones and pooling (added)
- `derivClient.ts`: 25s keep-alive ping, automatic reconnect (5 tries, fresh login URL each time) and re-subscription of live feeds/open contracts. A contract that settled during a drop is reported again as sold. If a buy was in flight when the socket dropped, the Journal says to check Transactions. "Lost connection" now shows only if all reconnects fail.
- `wakeLock.ts`: keeps the phone screen on while an AI or bulk run is active (Android Chrome, iOS Safari 16.4+). Strategies run inside the browser tab, so a locked phone can still pause them: keep the tab open and in front.
- Add to home screen: `public/manifest.webmanifest`, icons in `public/assets/`, tags in `index.html`. Android Chrome: menu > Install app. iOS Safari: Share > Add to Home Screen.
- Learning is pooled across markets (`ALL|contract|duration`), old per-market data is merged automatically.
- Not tested on real phones or against live Deriv; run `npm run type-check` and `npm run build`.

## Burst bulk trades + recovery modes (added)
- Bulk Trades "FIRE ALL AT ONCE (BURST)" (on by default): the NO. OF BULK TRADES contracts are all bought together when Start is pressed (concurrent chunks of 10), not one after another. MAX ENTRY TICKS (default 3, max 5) is the slippage cap: if that many ticks pass before all buys are sent, the rest are NOT sent. The Journal and results then show how many entry ticks and last digits the burst ended up with. The panel shows the total stake of the burst before you press Start; the burst also trims itself to what the balance can cover.
- Both Sides starts both bursts in the same instant. Note: Even + Odd (or Rise + Fall) on the same tick always has exactly one winner, so the pair loses the house margin each time.
- AI Trader "After a loss": Martingale (same side, bigger stake, default), Auto-flip (opposite side, bigger stake) or Flat (no recovery). Auto-flip is no longer hard-coded.
- Still to do: small-balance handling, cooldown / daily limit / journal CSV, Only Ups/Downs pair option.
