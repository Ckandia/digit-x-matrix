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
