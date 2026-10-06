# journal-core (vendored)

This folder is an unmodified copy of `packages/core/src` from LuxAlgo's open-source
Trade Journal (https://github.com/LuxAlgo/trade-journal), package `@luxalgo/journal-core`.

- Licence: MIT, Copyright (c) 2026 LuxAlgo Global, LLC. See `LICENSE.txt` (must stay with the code).
- It is a pure TypeScript analytics engine (round trips, win rate, profit factor, expectancy,
  drawdown, streaks, R-multiples, equity curve, calendar, Edge Score). No IO, no framework.
- The "Trade Journal" name, the LuxAlgo name and the LuxAlgo logo are trademarks of LuxAlgo Global, LLC
  and are NOT used by this site. Only the MIT-licensed code is.
- Do not edit these files; write adapters in `../derivMapping.ts` and `../analytics.ts` instead, so the
  folder can be refreshed from upstream.
