# digit-x-matrix: how the AI decides to buy (complete logic, as built)

Paste this as a prompt to describe or rebuild the behaviour. It matches the code in `digit-x-matrix-single.zip`.

---

## Role

You are a Deriv trading bot that buys a **basket of 3 contracts at the same instant** on the 1-second volatility indices. Each market is analysed on its own. The backend decides when to buy. The frontend AI buys on the backend's signal and does not wait for anything else.

## 1. Data

- The backend keeps a rolling window of the last **300 ticks** per market and takes the **last digit** of every price (using the market's decimals).
- It re-scans on every tick and sends signals to the AI over a websocket.
- A "run" is consecutive ticks whose last digits all favour one contract. The only run length that fires is **2 ticks** (`MIN_RUN = 2`).

## 2. Digit contracts and their digits

| Contract | Digits |
|---|---|
| Even | 0 2 4 6 8 |
| Odd | 1 3 5 7 9 |
| Over 4 | 5 6 7 8 9 |
| Under 5 | 0 1 2 3 4 |

Opposites: Even/Odd and Over 4/Under 5.

## 3. Bias: the four key digits (this decides "favoured")

1. Count how often each digit 0-9 appeared in the window.
2. Rank the digits. More appearances comes first; a tie goes to the digit seen most recently.
3. The four key digits are the **1st, 2nd and 3rd most frequent** digits and the **least frequent** digit. For the least frequent digit, a tie goes to the digit not seen for the longest.
4. A key digit **supports** a contract like this:
   - The 1st, 2nd and 3rd most frequent digits support a contract when the digit is one of the contract's digits.
   - The least frequent digit supports a contract when it is **not** one of the contract's digits (a rare odd digit leaves the even digits to appear).
5. Each contract's `support` is how many of the 4 key digits support it (0-4). Opposites always add up to 4.
6. A contract is **favoured** when `support >= 2` (two of four is enough) and it leads its opposite:
   - more supporting digits than the opposite; or
   - on a 2-2 tie, a larger share of the window (share = % of ticks that ended on its digits); or
   - if the share is also tied, it holds the 1st (most frequent) digit.
   - So one of every opposite pair is always favoured, and the AI never leans both ways.
7. Strength % (used for ranking) = `(support - 1) x 20 + 2 x max(0, share - 50)`, capped at 100. Default minimum signal strength is 20.

## 4. The entry signal (no waiting)

A contract is **confirmed** when both are true:
- its **run is on at exactly 2 ticks** (at most 1 tick past, for a late poll), and
- it is **favoured** (section 3).

Nothing else gates it: no trend, no virtual hook, no 3-tick level, no replayed hit rate, no entry-run wait. Each run is bought **once**.

## 5. Which basket is bought (the legs need not agree)

**Single-contract path (the one that fires most).** ONE confirmed digit contract X is enough.
- Partner = the favoured contract of the other digit class. If X is Even or Odd, the partner is Over 4 or Under 5. If X is Over 4 or Under 5, the partner is Even or Odd.
- The two digit legs form one of 4 bases: Even+Under 5, Odd+Over 4, Even+Over 4, Odd+Under 5.

**Full-pair path.** Both digit legs of a base have a 2-tick run together and both are favoured. If a full-pair basket is already on for that market, the single-contract basket is skipped. Only one basket is generated per market per look (the strongest, then the most recent run).

**Third contract (direction), V2:** judged only from live data, by the backend: the confirmed 1-tick trend (swings over the last 60 ticks) and the last 5 NON-FLAT price moves.
- Strong bullish: trend bullish AND last 3 moves up AND at least 4 of the last 5 up = **Only Ups** (momentum). Strong bearish mirrors it = **Only Downs**.
- Moderate bullish: trend bullish AND at least 3 of the last 5 up AND not strong AND the last 2 moves are not both down = **Rise** (drift). Moderate bearish = **Fall**.
- Anything else (no confirmed trend, a trend that conflicts with the moves, fewer than 5 non-flat moves) = **NO DIRECTION: no basket is bought**. Never a default Rise, never bullish by default, never the last tick.
- 4 bases x 2 regimes x 2 directions = **16 numbered setups**; the backend names the number and the AI must build the same one or buy nothing.

## 6. What is bought and how it is staked

- All contracts are priced first (one proposal per leg). Only if EVERY proposal is present, not dearer than its stake, pays more than it costs and the signal is under 1.5 s old are all the buys sent in the same turn. Otherwise **nothing** is bought and the run is not replayed.
- Digit contracts run 1 tick. Only Ups/Downs run 2 ticks. Rise/Fall run per the contract rules.
- Total stake is split by share:
  - Momentum: 40% / 40% / 20%.
  - Drift: 35% / 35% / 30%.
- The smallest stake per leg is 0.35, so the minimum total stake is `0.35 / smallest share` (it is raised automatically and logged).
- **Optional cover (off by default):** a 4th contract, Differs from the least frequent digit, at 1 tick. Shares are 35/35/15/15 (momentum) or 30/30/25/15 (drift).
- The AI will not buy if the total stake is more than the account balance.

## 7. Stake ladder (after each basket settles; all legs are judged together as one trade)

- **Full sweep** (every contract returned 0): the total stake is multiplied by the multiplier (default x1.5). After `max_steps` full sweeps in a row it returns to the base stake.
- **Partial loss** (something came back but less than the stake): the stake stays the same.
- **Win** (net profit): the stake returns to the base stake.
- Stop loss and take profit are judged on the account total. Capital protection caps the first trades at the base stake.
- After a loss the AI recovers on the same market and pair until a switch condition is met (default 45 seconds without an entry). This is a checkbox.

## 8. Protections that can delay or cancel a buy (not signal waits)

- Connection latency guard: if the connection is slower than 500 ms, the signal is dropped, never bought late.
- A signal older than 1.5 seconds is dropped. The AI polls every 100 ms.
- `max_trades_per_hour` pacing, if set.
- The self-review "skip" list does **not** apply to baskets. It still applies outside basket mode.
- Touch / No Touch are never traded by the AI.

## 9. Honest note for any reader of this logic

Every contract has a negative expected value (payout about 0.83x; break-even about 53-55%). The digit bias is a description of the last 300 random ticks, not a proven edge. Buying more often means losing faster on average. A combination of contracts does not turn it positive. Use small stakes and test on a demo account first.
