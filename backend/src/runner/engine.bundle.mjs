// src/pages/bulk-trader/tradingKnowledge.ts
var CONTRACT_NOTES = [
  // 1. Directional & trend
  {
    name: "Rise / Fall",
    group: "Directional & Trend",
    types: ["CALL", "PUT"],
    how: "Exit price strictly higher (Rise) or strictly lower (Fall) than the entry price. A flat tick loses both.",
    tip: "Gauge momentum on very short charts (5-tick or 1-minute).",
    tick: "one_tick",
    supported: true
  },
  {
    name: "Higher / Lower",
    group: "Directional & Trend",
    types: [],
    // Deriv uses CALL/PUT with a barrier: the same codes as Rise/Fall, so it cannot be told apart here
    how: "Win if the exit price finishes above (Higher) or below (Lower) a barrier you choose.",
    tip: "Best when a strong breakout past a clear structural level is expected.",
    tick: "multi_tick",
    barrier: true,
    regime: "balanced",
    supported: false,
    unsupported_reason: "Deriv sells it under the same CALL/PUT codes as Rise/Fall, so the shared refusal list could switch Rise/Fall off by mistake. Needs its own contract key first."
  },
  {
    name: "Only Ups / Only Downs",
    group: "Directional & Trend",
    types: ["RUNHIGH", "RUNLOW"],
    how: "Win only if every tick after entry rises (Ups) or falls (Downs). One flat or reversed tick loses.",
    tip: "Extremely high risk; only in clean aggressive impulse waves.",
    tick: "multi_tick",
    supported: true
  },
  // 2. Range & boundary
  {
    name: "Ends Between",
    group: "Range & Boundary",
    types: ["EXPIRYRANGE"],
    how: "Win if the final tick finishes inside your upper and lower barriers.",
    tip: "Suits low-volatility consolidating markets.",
    tick: "multi_tick",
    barrier: true,
    regime: "ranging",
    supported: true
  },
  {
    name: "Ends Outside",
    group: "Range & Boundary",
    types: ["EXPIRYMISS"],
    how: "Win if the final tick finishes above the high barrier or below the low barrier.",
    tip: "Suits the moments right before major news or sudden breakouts.",
    tick: "multi_tick",
    barrier: true,
    regime: "trending",
    supported: true
  },
  {
    name: "Stays Between",
    group: "Range & Boundary",
    types: ["RANGE"],
    how: "Watches every tick: win if the price never touches or breaches either barrier.",
    tip: "Needs quiet, range-bound conditions.",
    tick: "multi_tick",
    barrier: true,
    regime: "ranging",
    supported: true
  },
  {
    name: "Goes Outside",
    group: "Range & Boundary",
    types: ["UPORDOWN"],
    how: "Watches every tick: win if the price touches or breaches either barrier at any point.",
    tip: "Needs a sharp spike or expansion.",
    tick: "multi_tick",
    barrier: true,
    regime: "trending",
    supported: true
  },
  // 3. Barrier touch & tick based
  {
    name: "Touch",
    group: "Barrier Touch & Tick-Based",
    types: ["ONETOUCH"],
    how: "Win if the price reaches the barrier at any point in the contract.",
    tip: "Set the target just past minor local highs/lows where price tends to hunt liquidity.",
    tick: "multi_tick",
    barrier: true,
    regime: "trending",
    supported: true
  },
  {
    name: "No Touch",
    group: "Barrier Touch & Tick-Based",
    types: ["NOTOUCH"],
    how: "Win if the price completely avoids the barrier the entire time.",
    tip: "Put the barrier far enough outside the current range during quiet phases.",
    tick: "multi_tick",
    barrier: true,
    regime: "ranging",
    supported: true
  },
  {
    name: "High Tick / Low Tick",
    group: "Barrier Touch & Tick-Based",
    types: ["TICKHIGH", "TICKLOW"],
    how: "Pick one of the next 5 ticks: win if it is the highest (High Tick) or lowest (Low Tick) of the five.",
    tip: "Pure micro-tick statistics, not chart patterns.",
    tick: "multi_tick",
    supported: true
  },
  // 4. Mathematical & averaging
  {
    name: "Even / Odd",
    group: "Mathematical & Averaging",
    types: ["DIGITEVEN", "DIGITODD"],
    how: "Win if the last digit of the exit tick is even (0,2,4,6,8) or odd (1,3,5,7,9).",
    tip: "A near 50/50 probability game minus the payout margin. Needs strict risk management.",
    tick: "one_tick",
    supported: true
  },
  {
    name: "Asians",
    group: "Mathematical & Averaging",
    types: ["ASIANU", "ASIAND"],
    how: "Win if the exit price is above (Up) or below (Down) the average of all ticks in the contract.",
    tip: "Smooths spike volatility because the average path matters, not just the last tick.",
    tick: "multi_tick",
    supported: true
  },
  {
    name: "Reset Call / Reset Put",
    group: "Mathematical & Averaging",
    types: ["RESETCALL", "RESETPUT"],
    how: "Like Rise/Fall, but the barrier can reset to a new point mid-contract, giving a second chance.",
    tip: "Needs a duration long enough for the reset to trigger.",
    tick: "multi_tick",
    supported: true
  },
  // 5. Growth & risk management
  {
    name: "Accumulators",
    group: "Growth & Risk Management",
    types: ["ACCU"],
    how: "Payout compounds each tick while the price stays inside a channel; one breach ends the trade as a loss.",
    tip: "Low growth rate (1%) for a wider buffer, high (5%) for fast compounding in low-noise trends.",
    tick: "multi_tick",
    supported: false,
    unsupported_reason: "An open-position contract (no fixed duration). It needs its own monitoring and exit logic, which the fixed-duration engine does not have."
  },
  {
    name: "Multipliers",
    group: "Growth & Risk Management",
    types: ["MULTUP", "MULTDOWN"],
    how: "Long/short position with a multiplier (x100, x500). Profit and loss are magnified; the loss cannot exceed the stake.",
    tip: "Trend-following with a predefined stop loss.",
    tick: "multi_tick",
    supported: false,
    unsupported_reason: "A CFD-style position held for seconds to hours. It needs its own monitoring and exit logic, which the fixed-duration engine does not have."
  }
];
var byType = /* @__PURE__ */ new Map();
for (const note of CONTRACT_NOTES) for (const t of note.types) byType.set(t, note);
var noteFor = (contract_type) => byType.get(contract_type);
var isBarrierContract = (contract_type) => !!noteFor(contract_type)?.barrier;
var STREAK_PLAYBOOK = {
  /** The notes: don't bet a reversal after 2 evens; wait for a rare 5+ streak. */
  min_streak: 5,
  /** Tick speed = average absolute price change per tick. Compared over the last N ticks... */
  velocity_recent_ticks: 5,
  /** ...against the N ticks before them. */
  velocity_baseline_ticks: 20,
  /** "Slowing" = recent speed is below this fraction of the baseline speed. */
  velocity_slow_ratio: 0.8,
  /** Learner bucket: results of this strategy are recorded on their own, apart from other Even/Odd signals. */
  learner_bucket: "streak"
};

// src/pages/bulk-trader/contractRules.ts
var BUILT_IN = {
  CALL: { min: 1, max: 10 },
  PUT: { min: 1, max: 10 },
  DIGITEVEN: { min: 1, max: 10 },
  DIGITODD: { min: 1, max: 10 },
  DIGITOVER: { min: 1, max: 10 },
  DIGITUNDER: { min: 1, max: 10 },
  ASIANU: { min: 5, max: 10 },
  ASIAND: { min: 5, max: 10 },
  RUNHIGH: { min: 2, max: 5 },
  RUNLOW: { min: 2, max: 5 },
  TICKHIGH: { min: 5, max: 5 },
  TICKLOW: { min: 5, max: 5 },
  ONETOUCH: { min: 5, max: 10 },
  NOTOUCH: { min: 5, max: 10 },
  RESETCALL: { min: 5, max: 10 },
  RESETPUT: { min: 5, max: 10 },
  EXPIRYRANGE: null,
  EXPIRYMISS: null,
  // Stays Between / Goes Outside: treated as not-in-ticks until Deriv's live rules (contracts_for)
  // show a tick duration for them. Until then the AI will not buy them.
  RANGE: null,
  UPORDOWN: null
};
var rest_base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || "").trim().replace(/\/$/, "");
var live = {};
var loadLiveRules = async (symbols) => {
  if (!rest_base) return;
  await Promise.all(
    symbols.filter((s) => !(s in live)).map(async (symbol) => {
      try {
        const res = await fetch(`${rest_base}/api/contracts/${symbol}`);
        const body = res.ok ? await res.json() : null;
        live[symbol] = body?.rules ?? null;
      } catch {
        live[symbol] = null;
      }
    })
  );
};
var tickRange = (symbol, type) => {
  const l = live[symbol];
  if (l && type in l) return l[type];
  return type in BUILT_IN ? BUILT_IN[type] : null;
};
var refused = {};
var REFUSED_MS = 6 * 36e5;
var markRefused = (symbol, type) => {
  refused[`${symbol}|${type}`] = Date.now();
};
var isRefused = (symbol, type) => {
  const at = refused[`${symbol}|${type}`];
  return !!at && Date.now() - at < REFUSED_MS;
};
var tradeTicks = (symbol, type) => {
  const r = tickRange(symbol, type);
  if (!r || isRefused(symbol, type)) return null;
  if (isBarrierContract(type)) return r.min;
  if (type === "RUNHIGH" || type === "RUNLOW") return r.min;
  return r.min <= 1 && r.max >= 1 ? 1 : null;
};
var isTickTradable = (symbol, type) => tradeTicks(symbol, type) !== null;
var skewBucket = (recent, type) => {
  const w = recent?.n50;
  if (!w || w.n < 50) return void 0;
  const pct = type === "DIGITEVEN" ? w.even_pct : type === "DIGITODD" ? w.odd_pct : type === "DIGITOVER" ? w.over4_pct ?? w.over5_pct : type === "DIGITUNDER" ? w.under5_pct : void 0;
  if (pct === void 0) return void 0;
  return pct < 50 ? "min" : pct < 60 ? "flat" : pct < 70 ? "lean" : "strong";
};

// src/pages/bulk-trader/paperStats.ts
var rest_base2 = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || "").trim().replace(/\/$/, "");
var ONE_TICK_PAPER_TYPES = ["DIGITEVEN", "DIGITODD", "DIGITOVER", "DIGITUNDER", "CALL", "PUT"];
var fetchPaperReport = async () => {
  if (!rest_base2) return null;
  try {
    const res = await fetch(`${rest_base2}/api/paper/stats`);
    if (!res.ok) return null;
    const { data } = await res.json();
    return data;
  } catch {
    return null;
  }
};

// src/pages/bulk-trader/learningEngine.ts
var statType = (type, bucket) => bucket ? `${type}@${bucket}` : type;
var MIN_EXPLORE = 20;
var MIN_PROVEN = 30;
var Z_LOWER = 1.96;
var DEFAULT_PAYOUT_MULT = 1.95;
var PAPER_PAYOUT_MULT = 1.82;
var PAPER_REFRESH_MS = 10 * 6e4;
var STORE_KEY = "dxm_learning_v1";
var rest_base3 = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || "").trim().replace(/\/$/, "");
var randn = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
var POOL = "ALL";
var cellKey = (_symbol, type, duration) => `${POOL}|${type}|${duration}`;
var emptyCell = () => ({ wins: 0, losses: 0, staked: 0, profit: 0, payout_ratio_sum: 0 });
var addInto = (a, b) => {
  a.wins += b.wins;
  a.losses += b.losses;
  a.staked += b.staked;
  a.profit += b.profit;
  a.payout_ratio_sum += b.payout_ratio_sum;
};
var poolCells = (cells) => {
  const out = {};
  for (const [key, c] of Object.entries(cells)) {
    const [, type, duration] = key.split("|");
    const pk = `${POOL}|${type}|${duration}`;
    addInto(out[pk] ||= emptyCell(), c);
  }
  return out;
};
var n_of = (c) => c ? c.wins + c.losses : 0;
var makeProfileId = async (loginid) => {
  try {
    const data = new TextEncoder().encode(`dxm:${loginid}`);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  } catch {
    return `p${Array.from(loginid).reduce((a, c) => a * 31 + c.charCodeAt(0) >>> 0, 7)}xxxxxxxx`;
  }
};
var LearningEngine = class {
  mode;
  cells = {};
  /** Results of the backend's 24/7 paper trading, per contract type, every market pooled (1-tick contracts only). */
  paper = {};
  paper_at = 0;
  /** The AI's own virtual-hook paper trades (this browser), per 1-tick contract type. Kept between sessions. */
  virtual = {};
  profile;
  constructor(profile, mode = "learn") {
    this.profile = profile;
    this.mode = mode;
    try {
      this.cells = JSON.parse(localStorage.getItem(`${STORE_KEY}:${profile}`) || "{}");
    } catch {
      this.cells = {};
    }
    this.cells = poolCells(this.cells);
    try {
      this.virtual = JSON.parse(localStorage.getItem(`${STORE_KEY}:${profile}:virtual`) || "{}");
    } catch {
      this.virtual = {};
    }
  }
  /**
   * A paper trade made by the virtual hook on live ticks. It is the same win/lose event as a real trade, so it counts
   * as evidence for the contract (like the backend paper trader's results). Touch / No Touch are left out, see syncPaper.
   */
  recordVirtual(contract_type, won) {
    if (!ONE_TICK_PAPER_TYPES.includes(contract_type)) return;
    const r = this.virtual[contract_type] ||= { wins: 0, losses: 0 };
    if (won) r.wins += 1;
    else r.losses += 1;
    try {
      localStorage.setItem(`${STORE_KEY}:${this.profile}:virtual`, JSON.stringify(this.virtual));
    } catch {
    }
  }
  /** What the hook's own paper trades have shown so far, per contract type. */
  virtualEvidence() {
    return this.virtual;
  }
  /** Merges what the backend remembers (Neon) with the browser's copy: whichever has more trades wins per cell. */
  async syncFromBackend() {
    if (!rest_base3) return;
    try {
      const res = await fetch(`${rest_base3}/api/learning/stats/${this.profile}`);
      if (!res.ok) return;
      const { data } = await res.json();
      const remote = {};
      for (const r of data || []) {
        const key = cellKey(r.symbol, r.contract_type, r.duration);
        addInto(remote[key] ||= emptyCell(), {
          wins: r.wins,
          losses: r.losses,
          staked: r.staked,
          profit: r.profit,
          payout_ratio_sum: r.payout_ratio_sum
        });
      }
      for (const [key, cell] of Object.entries(remote)) {
        if (n_of(cell) > n_of(this.cells[key])) this.cells[key] = cell;
      }
      this.save();
    } catch {
    }
  }
  /**
   * Pulls what the backend's paper trader has seen (it trades virtually on every market around the clock, token-free)
   * and counts it as evidence next to this account's own trades. A paper trade is the same win/lose event as a real
   * one, so it is added to the same win/loss counts; payout comes from the real trades (or a typical 1-tick payout).
   * Touch / No Touch are left out: their payout swings with the barrier, so a win rate alone says nothing.
   */
  async syncPaper() {
    this.paper_at = Date.now();
    const report = await fetchPaperReport();
    if (!report) return;
    const next = {};
    for (const c of report.cells) {
      if (!ONE_TICK_PAPER_TYPES.includes(c.contract_type)) continue;
      const r = next[c.contract_type] ||= { wins: 0, losses: 0 };
      r.wins += c.wins;
      r.losses += c.n - c.wins;
    }
    this.paper = next;
  }
  /** The account's own cell for this key, plus the backend's paper evidence for the same contract. */
  merged(key, type) {
    const own = this.cells[key];
    const b = this.paper[type];
    const v = this.virtual[type];
    if (!b && !v) return own;
    const p = { wins: (b?.wins ?? 0) + (v?.wins ?? 0), losses: (b?.losses ?? 0) + (v?.losses ?? 0) };
    const paper_n = p.wins + p.losses;
    return {
      wins: (own?.wins ?? 0) + p.wins,
      losses: (own?.losses ?? 0) + p.losses,
      staked: own?.staked ?? 0,
      profit: own?.profit ?? 0,
      payout_ratio_sum: (own?.payout_ratio_sum ?? 0) + paper_n * PAPER_PAYOUT_MULT
    };
  }
  /** Deriv refused this symbol/contract: skip it for the next 6 hours (shared list, see contractRules). */
  markUnavailable(symbol, type, _duration) {
    markRefused(symbol, type);
  }
  save() {
    try {
      localStorage.setItem(`${STORE_KEY}:${this.profile}`, JSON.stringify(this.cells));
    } catch {
    }
  }
  record(o) {
    const key = cellKey(o.symbol, o.contract_type, o.duration);
    const c = this.cells[key] ||= { wins: 0, losses: 0, staked: 0, profit: 0, payout_ratio_sum: 0 };
    const win = o.profit > 0;
    c.wins += win ? 1 : 0;
    c.losses += win ? 0 : 1;
    c.staked += o.stake;
    c.profit += o.profit;
    c.payout_ratio_sum += o.payout && o.payout > o.stake ? o.payout / o.stake : 0;
    this.save();
    if (!rest_base3) return;
    fetch(`${rest_base3}/api/learning/outcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: this.profile, ...o, symbol: POOL, payout: o.payout ?? 0 })
    }).catch(() => void 0);
  }
  globalPayoutMult() {
    let sum = 0;
    let n = 0;
    for (const c of Object.values(this.cells)) {
      sum += c.payout_ratio_sum;
      n += n_of(c);
    }
    return n > 0 && sum > 0 ? sum / n : DEFAULT_PAYOUT_MULT;
  }
  breakeven(c) {
    const n = n_of(c);
    const mult = c && n > 0 && c.payout_ratio_sum > 0 ? c.payout_ratio_sum / n : this.globalPayoutMult();
    return 1 / Math.max(mult, 1.01);
  }
  posterior(c) {
    const a = 1 + (c?.wins ?? 0);
    const b = 1 + (c?.losses ?? 0);
    const mean = a / (a + b);
    const sd = Math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)));
    return { mean, sd };
  }
  lowerBound(c) {
    const { mean, sd } = this.posterior(c);
    return mean - Z_LOWER * sd;
  }
  sampleEdge(c) {
    const { mean, sd } = this.posterior(c);
    return mean + sd * randn() - this.breakeven(c);
  }
  /** The one duration this contract trades for (1 tick; barrier contracts: Deriv's shortest), or -1 if it must be skipped. */
  chooseDuration(symbol, type) {
    return tradeTicks(symbol, type) ?? -1;
  }
  /**
   * True when this contract has a PROVEN edge (enough trades and the pessimistic end of its win rate beats the payout's
   * break-even), or when the learner is not in 'edge_gate' mode. The engine asks this right before every LIVE buy, whatever
   * path picked the contract (signal, virtual hook, opposite, recovery), so no route can spend real money on an unproven one.
   */
  isTradable(symbol, type, bucket, duration_ticks) {
    if (this.mode !== "edge_gate") return true;
    const duration = duration_ticks ?? this.chooseDuration(symbol, type);
    if (duration < 0) return false;
    const c = this.merged(cellKey(symbol, statType(type, bucket), duration), type);
    return n_of(c) >= MIN_PROVEN && this.lowerBound(c) > this.breakeven(c);
  }
  /** Chooses the next trade from the live candidates, or null if nothing qualifies right now. */
  pickBest(candidates) {
    let best = null;
    let bestScore = -Infinity;
    if (Date.now() - this.paper_at > PAPER_REFRESH_MS) void this.syncPaper();
    for (const cand of candidates) {
      const duration = this.chooseDuration(cand.symbol, cand.contract_type);
      if (duration < 0) continue;
      const c = this.merged(cellKey(cand.symbol, statType(cand.contract_type, cand.bucket), duration), cand.contract_type);
      if (this.mode === "edge_gate" && !(n_of(c) >= MIN_PROVEN && this.lowerBound(c) > this.breakeven(c))) continue;
      const score = this.sampleEdge(c) + cand.confidence / 100 * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = { ...cand, duration_ticks: duration };
      }
    }
    return best;
  }
  /** While a combination is still being explored, cap the stake at a quarter of the base stake. */
  governStake(stake, baseStake, cand) {
    if (this.mode !== "learn") return stake;
    const c = this.cells[cellKey(cand.symbol, statType(cand.contract_type, cand.bucket), cand.duration_ticks ?? 0)];
    if (n_of(c) >= MIN_EXPLORE) return stake;
    return Number(Math.min(stake, Math.max(0.35, baseStake * 0.25)).toFixed(2));
  }
  /** Fetches what Deriv actually offers for these markets (see contractRules.ts). */
  loadRules(symbols) {
    return loadLiveRules(symbols);
  }
  /** Read-only copy of per-combination results, for the Strategy Lab. */
  cellsSnapshot() {
    return Object.entries(this.cells).map(([key, c]) => {
      const [symbol, contract_type, d] = key.split("|");
      const n = n_of(c);
      return {
        symbol,
        contract_type,
        duration: Number(d),
        n,
        win_rate: n ? c.wins / n : 0,
        payout_mult: n && c.payout_ratio_sum > 0 ? c.payout_ratio_sum / n : this.globalPayoutMult(),
        breakeven: this.breakeven(c),
        proven_edge: n >= MIN_PROVEN && this.lowerBound(c) > this.breakeven(c)
      };
    });
  }
  summary() {
    const rows = Object.entries(this.cells).map(([key, c]) => {
      const n = n_of(c);
      const edge = n >= MIN_PROVEN && this.lowerBound(c) > this.breakeven(c);
      return { key, n, win_rate: n ? c.wins / n : 0, breakeven: this.breakeven(c), profit: c.profit, proven_edge: edge };
    });
    return {
      total_trades: rows.reduce((s, r) => s + r.n, 0),
      combinations: rows.length,
      proven: rows.filter((r) => r.proven_edge).length,
      top: rows.sort((a, b) => b.n - a.n).slice(0, 5)
    };
  }
};
var candidatesFromSnapshots = (snapshots, allowed) => {
  const out = [];
  for (const [symbol, snap] of Object.entries(snapshots)) {
    for (const s of snap.signals) {
      if (!allowed.includes(s.contract_type) || !isTickTradable(symbol, s.contract_type)) continue;
      const strategy = s.strategy;
      const bucket = strategy === "streak_reversal" ? STREAK_PLAYBOOK.learner_bucket : skewBucket(snap.stats.recent, s.contract_type);
      out.push({ symbol, ...s, bucket });
    }
  }
  return out;
};

// src/pages/journal/selfReview.ts
var WATCH_CONFIDENCE_FACTOR = 0.6;
var cellKey2 = (symbol, type, strategy) => `${symbol}|${type}${strategy ? `@${strategy}` : ""}`;
var typeKey = (type, strategy) => cellKey2("*", type, strategy);
var isBlocked = (gate, symbol, type, strategy) => !!gate && (gate.blocked.has(cellKey2(symbol, type, strategy)) || gate.blocked.has(typeKey(type, strategy)));
var applyGate = (snapshots, gate) => {
  if (!gate || gate.blocked.size === 0 && gate.watch.size === 0) return snapshots;
  const out = {};
  for (const [symbol, snap] of Object.entries(snapshots)) {
    const signals = [];
    for (const s of snap.signals) {
      if (isBlocked(gate, symbol, s.contract_type, s.strategy)) continue;
      const lagging = gate.watch.has(cellKey2(symbol, s.contract_type, s.strategy)) || gate.watch.has(typeKey(s.contract_type, s.strategy));
      signals.push(lagging ? { ...s, confidence: Math.round(s.confidence * WATCH_CONFIDENCE_FACTOR) } : s);
    }
    out[symbol] = { ...snap, signals };
  }
  return out;
};

// src/pages/bulk-trader/trendFilter.ts
var SWING_K = 2;
var TREND_WINDOW = 60;
var findSwings = (prices, k = SWING_K) => {
  const highs = [];
  const lows = [];
  for (let i = k; i < prices.length - k; i++) {
    let is_high = true;
    let is_low = true;
    for (let j = 1; j <= k; j++) {
      if (!(prices[i] > prices[i - j]) || !(prices[i] >= prices[i + j])) is_high = false;
      if (!(prices[i] < prices[i - j]) || !(prices[i] <= prices[i + j])) is_low = false;
    }
    if (is_high) highs.push(prices[i]);
    if (is_low) lows.push(prices[i]);
  }
  return { highs, lows };
};
var detectTrend = (prices, k = SWING_K) => {
  const { highs, lows } = findSwings(prices, k);
  const higher_high = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
  const lower_low = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];
  if (higher_high && !lower_low) return "bullish";
  if (lower_low && !higher_high) return "bearish";
  return "none";
};

// src/pages/bulk-trader/autoPilotEngine.ts
var SWITCH_AFTER_LOSSES = 2;
var CONTRACT_FAMILIES = [
  { key: "even_odd", label: "Even / Odd", types: ["DIGITEVEN", "DIGITODD"] },
  { key: "over_under", label: "Over 4 / Under 5", types: ["DIGITOVER", "DIGITUNDER"] },
  { key: "rise_fall", label: "Rise / Fall", types: ["CALL", "PUT"], trend: true },
  { key: "touch", label: "Touch / No Touch", types: ["ONETOUCH", "NOTOUCH"] },
  { key: "only_ups_downs", label: "Only Ups / Only Downs", types: ["RUNHIGH", "RUNLOW"], trend: true }
];
var ALL_FAMILY_KEYS = CONTRACT_FAMILIES.map((f) => f.key);
var PROTECT_LOSS_STAKES = 3;
var ASSUMED_PAYOUT_RATIO = 0.83;
var EXPECTED_LOSS_PER_STAKE = 0.5 - 0.5 * ASSUMED_PAYOUT_RATIO;
var SPREAD_PER_STAKE = 0.5 * (1 + ASSUMED_PAYOUT_RATIO);
var MIN_STAKE = 0.35;
var recoveryStake = (ladder_spent, base, payout_ratio = ASSUMED_PAYOUT_RATIO) => {
  const ratio = payout_ratio > 0.2 && payout_ratio < 2 ? payout_ratio : ASSUMED_PAYOUT_RATIO;
  return Math.max(MIN_STAKE, Math.ceil((ladder_spent + base) / ratio * 100) / 100);
};
var DEFAULT_VIRTUAL_CONFIRMATIONS = 2;
var MAX_VIRTUAL_CONFIRMATIONS = 5;
var MAX_OPPOSITE_PAPER_WINS = 25;
var bothSidesType = (type) => type === "RUNHIGH" || type === "RUNLOW";
var FOLLOW_HOOK_TYPES = /* @__PURE__ */ new Set(["DIGITEVEN", "DIGITODD"]);
var MAX_FOLLOW_PAPER_LOSSES = 25;
var AUTOPILOT_CONTRACT_TYPES = [
  "DIGITEVEN",
  "DIGITODD",
  "DIGITOVER",
  // Over 4
  "DIGITUNDER",
  // Under 5
  "CALL",
  "PUT",
  "RUNHIGH",
  "RUNLOW",
  "ONETOUCH",
  "NOTOUCH",
  "EXPIRYRANGE",
  "EXPIRYMISS",
  "RANGE",
  "UPORDOWN",
  "ASIANU",
  "ASIAND",
  "TICKHIGH",
  "TICKLOW",
  "RESETCALL",
  "RESETPUT"
];
var FLIP_PARTNER = {
  DIGITEVEN: "DIGITODD",
  DIGITODD: "DIGITEVEN",
  CALL: "PUT",
  PUT: "CALL",
  RUNHIGH: "RUNLOW",
  RUNLOW: "RUNHIGH",
  ONETOUCH: "NOTOUCH",
  NOTOUCH: "ONETOUCH",
  EXPIRYRANGE: "EXPIRYMISS",
  EXPIRYMISS: "EXPIRYRANGE",
  RANGE: "UPORDOWN",
  UPORDOWN: "RANGE",
  ASIANU: "ASIAND",
  ASIAND: "ASIANU",
  TICKHIGH: "TICKLOW",
  TICKLOW: "TICKHIGH",
  RESETCALL: "RESETPUT",
  RESETPUT: "RESETCALL",
  DIGITOVER: "DIGITUNDER",
  DIGITUNDER: "DIGITOVER"
};
var switchKey = (c) => c.contract_type === "DIGITOVER" ? "OVER4" : c.contract_type === "DIGITUNDER" ? "UNDER5" : c.contract_type;
var SWITCH_PARTNER_KEY = {
  DIGITEVEN: "OVER4",
  DIGITODD: "UNDER5",
  ONETOUCH: "UNDER5",
  NOTOUCH: "OVER4",
  CALL: "UNDER5",
  PUT: "OVER4",
  OVER4: "UNDER5",
  UNDER5: "OVER4"
};
var partnerCandidate = (symbol, from) => {
  const key = SWITCH_PARTNER_KEY[switchKey(from)] ?? "UNDER5";
  const over = key === "OVER4";
  return {
    symbol,
    family: "digits",
    contract_type: over ? "DIGITOVER" : "DIGITUNDER",
    prediction: over ? 4 : 5,
    duration_ticks: 1,
    label: over ? "Over 4" : "Under 5",
    confidence: 0,
    basis: `Auto flip: ${from.label} lost, switching to ${over ? "Over 4" : "Under 5"}.`
  };
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var OPPOSITE_LABEL = {
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
  DIGITOVER: "Over 4",
  DIGITUNDER: "Under 5",
  CALL: "Rise",
  PUT: "Fall",
  ONETOUCH: "Touch",
  NOTOUCH: "No Touch",
  RUNHIGH: "Only Ups",
  RUNLOW: "Only Downs"
};
var PAPER_SUPPORTED = /* @__PURE__ */ new Set(["DIGITEVEN", "DIGITODD", "DIGITOVER", "DIGITUNDER", "CALL", "PUT", "ONETOUCH", "NOTOUCH", "RUNHIGH", "RUNLOW"]);
var paperOutcome = (type, entry, after, pip, needed = 1) => {
  if (isTouch(type)) {
    const touched = after.slice(0, needed).some((q) => q >= entry + 0.5);
    if (touched) return type === "ONETOUCH";
    return after.length >= needed ? type === "NOTOUCH" : null;
  }
  if (type === "RUNHIGH" || type === "RUNLOW") {
    let previous = entry;
    for (const q of after.slice(0, needed)) {
      if (type === "RUNHIGH" ? !(q > previous) : !(q < previous)) return false;
      previous = q;
    }
    return after.length >= needed ? true : null;
  }
  if (after.length < 1) return null;
  const exit = after[0];
  const digit = Number(exit.toFixed(pip).slice(-1));
  switch (type) {
    case "DIGITEVEN":
      return digit % 2 === 0;
    case "DIGITODD":
      return digit % 2 === 1;
    case "DIGITOVER":
      return digit > 4;
    case "DIGITUNDER":
      return digit < 5;
    case "CALL":
      return exit > entry;
    case "PUT":
      return exit < entry;
    default:
      return null;
  }
};
var DEFAULT_FOLLOW_TICKS = 2;
var MAX_FOLLOW_TICKS = 5;
var DEFAULT_ENTRY_TICK = 3;
var MIN_ENTRY_TICK = 2;
var MAX_ENTRY_TICK = 5;
var DEFAULT_ENTRY_WAIT_TICKS = 30;
var MIN_ENTRY_WAIT_TICKS = 10;
var MAX_ENTRY_WAIT_TICKS = 90;
var NO_ENTRY_SKIP_MS = 12e4;
var tickAgrees = (type, prediction, price, prev, pip) => {
  const d = Number(price.toFixed(pip).slice(-1));
  switch (type) {
    case "DIGITEVEN":
      return d % 2 === 0;
    case "DIGITODD":
      return d % 2 === 1;
    case "DIGITOVER":
      return d > (prediction ?? 4);
    case "DIGITUNDER":
      return d < (prediction ?? 5);
    case "CALL":
    case "RUNHIGH":
      return prev !== void 0 && price > prev;
    case "PUT":
    case "RUNLOW":
      return prev !== void 0 && price < prev;
    default:
      return null;
  }
};
var trailingRun = (type, prediction, prices, pip) => {
  let run = 0;
  let prev;
  for (const q of prices) {
    const a = tickAgrees(type, prediction, q, prev, pip);
    run = a ? run + 1 : 0;
    prev = q;
  }
  return run;
};
var TOUCH_BARRIER_ABS = 0.5;
var TOUCH_READ_TICKS = 5;
var TOUCH_READ_MIN = 1;
var NOTOUCH_READ_MAX = 0.5;
var reachRatio = (prices, ticks = TOUCH_READ_TICKS, barrier = TOUCH_BARRIER_ABS) => {
  const tail = prices.slice(-21);
  if (tail.length < 11) return null;
  let sum = 0;
  for (let i = 1; i < tail.length; i++) sum += Math.abs(tail[i] - tail[i - 1]);
  return sum / (tail.length - 1) * Math.sqrt(ticks) / barrier;
};
var touchReading = (type, prices) => {
  const r = reachRatio(prices);
  if (r === null) return false;
  if (type === "ONETOUCH") return r >= TOUCH_READ_MIN && prices[prices.length - 1] > prices[prices.length - 2];
  return r <= NOTOUCH_READ_MAX;
};
var entryScore = (type, prediction, prices, pip, target = DEFAULT_ENTRY_TICK) => {
  if (type === "ONETOUCH" || type === "NOTOUCH") {
    const r = reachRatio(prices);
    if (r === null) return 0;
    return type === "ONETOUCH" ? Math.min(1, r / TOUCH_READ_MIN) : Math.min(1, NOTOUCH_READ_MAX / Math.max(r, 1e-6));
  }
  const run = trailingRun(type, prediction, prices, pip);
  if (run >= target) return 0;
  return run === target - 1 ? 1 : run / Math.max(1, target - 1) * 0.9;
};
var followsStream = (type, prediction, prices, pip, n) => {
  const digitOf = (price) => Number(price.toFixed(pip).slice(-1));
  const tail = prices.slice(-n).map(digitOf);
  const digitsOk = (test) => tail.length === n && tail.every(test);
  switch (type) {
    case "DIGITEVEN":
      return digitsOk((d) => d % 2 === 0);
    case "DIGITODD":
      return digitsOk((d) => d % 2 === 1);
    case "DIGITOVER":
      return digitsOk((d) => d > (prediction ?? 4));
    case "DIGITUNDER":
      return digitsOk((d) => d < (prediction ?? 5));
    case "CALL":
    case "PUT":
    case "RUNHIGH":
    case "RUNLOW": {
      const up = type === "CALL" || type === "RUNHIGH";
      const last = prices.slice(-(n + 1));
      if (last.length < n + 1) return false;
      for (let i = 1; i < last.length; i++) if (up ? !(last[i] > last[i - 1]) : !(last[i] < last[i - 1])) return false;
      return true;
    }
    case "ONETOUCH":
    case "NOTOUCH":
      return touchReading(type, prices);
    default:
      return null;
  }
};
var TREND_NEEDED = { CALL: "bullish", PUT: "bearish", RUNHIGH: "bullish", RUNLOW: "bearish" };
var preferOneTick = (snapshots) => {
  const has_one_tick = Object.entries(snapshots).some(
    ([symbol, snap]) => snap.signals.some((sig) => tradeTicks(symbol, sig.contract_type) === 1)
  );
  if (!has_one_tick) return snapshots;
  const out = {};
  for (const [symbol, snap] of Object.entries(snapshots)) {
    out[symbol] = { ...snap, signals: snap.signals.filter((sig) => tradeTicks(symbol, sig.contract_type) === 1) };
  }
  return out;
};
var MIN_PAYOUT_RATIO = 1.05;
var REFUSAL_PATTERN = /not offered|duration|barrier|not available|unavailable|suspended|market is closed|no longer offered|selected tick|no return|offers no/i;
var pickBestGlobalCandidate = (all_snapshots, prefer_one_tick = true) => {
  let best = null;
  const snapshots = prefer_one_tick ? preferOneTick(all_snapshots) : all_snapshots;
  for (const [symbol, snapshot] of Object.entries(snapshots)) {
    for (const signal of snapshot.signals) {
      if (!AUTOPILOT_CONTRACT_TYPES.includes(signal.contract_type))
        continue;
      const ticks = tradeTicks(symbol, signal.contract_type);
      if (ticks === null) continue;
      if (!best || signal.confidence > best.confidence) best = { symbol, ...signal, duration_ticks: ticks };
    }
  }
  return best;
};
var pickFlipCandidate = (snapshots, symbol, previous) => {
  const flip_type = FLIP_PARTNER[previous.contract_type];
  const snapshot = snapshots[symbol];
  const live2 = snapshot?.signals.find((s) => s.contract_type === flip_type);
  const flip_ticks = tradeTicks(symbol, flip_type) ?? void 0;
  if (live2) return { symbol, ...live2, duration_ticks: flip_ticks };
  return {
    symbol,
    family: previous.family,
    contract_type: flip_type,
    duration_ticks: flip_ticks,
    prediction: flipPrediction(previous),
    label: `${previous.label} (flipped)`,
    confidence: 0,
    basis: "No live signal for this side yet \u2014 flipping anyway to continue the recovery ladder."
  };
};
var flipPrediction = (previous) => {
  if (previous.contract_type === "TICKHIGH" || previous.contract_type === "TICKLOW") {
    return previous.prediction === 5 ? 1 : 5;
  }
  return previous.prediction;
};
var NEEDS_SINGLE_BARRIER = /* @__PURE__ */ new Set(["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER", "ONETOUCH", "NOTOUCH"]);
var touch_ticks = /* @__PURE__ */ new Map();
var isTouch = (t) => t === "ONETOUCH" || t === "NOTOUCH";
var TOUCH_BARRIER = "+0.5";
var dutyTicks = (symbol, contract_type) => {
  const ticks = tradeTicks(symbol, contract_type);
  if (ticks === null) throw new Error(`${contract_type} on ${symbol} is not offered at 1 tick (or is temporarily refused)`);
  if (isTouch(contract_type)) return touch_ticks.get(`${symbol}|${contract_type}`) ?? 5;
  return ticks;
};
var buildTradeParameters = (candidate, stake, currency) => {
  const base = {
    amount: stake,
    basis: "stake",
    contract_type: candidate.contract_type,
    currency,
    underlying_symbol: candidate.symbol
  };
  if (candidate.contract_type === "TICKHIGH" || candidate.contract_type === "TICKLOW") {
    return { ...base, duration: 5, duration_unit: "t", selected_tick: Number(candidate.prediction) || 5 };
  }
  if (["EXPIRYRANGE", "EXPIRYMISS", "RANGE", "UPORDOWN"].includes(candidate.contract_type)) {
    const offset = Math.abs(Number(candidate.prediction) || 0);
    return {
      ...base,
      duration: dutyTicks(candidate.symbol, candidate.contract_type),
      duration_unit: "t",
      barrier: `+${offset}`,
      barrier2: `-${offset}`
    };
  }
  const parameters = {
    ...base,
    duration: dutyTicks(candidate.symbol, candidate.contract_type),
    duration_unit: "t"
  };
  if (isTouch(candidate.contract_type)) {
    parameters.barrier = TOUCH_BARRIER;
  } else if (candidate.contract_type === "DIGITOVER") {
    parameters.barrier = "4";
  } else if (candidate.contract_type === "DIGITUNDER") {
    parameters.barrier = "5";
  } else if (NEEDS_SINGLE_BARRIER.has(candidate.contract_type)) {
    parameters.barrier = String(candidate.prediction);
  }
  return parameters;
};
var AutoPilotEngine = class {
  connection;
  currency;
  getSnapshots;
  onEvent;
  config;
  step = 1;
  total_profit = 0;
  running = false;
  busy = false;
  lastCandidate = null;
  learner;
  hooks;
  refused = 0;
  ladder_spent = 0;
  last_wait_emit = 0;
  consecutive_losses = 0;
  win_streak = 0;
  // reverse martingale: wins in a row
  streak_profit = 0;
  // reverse martingale: what the current win streak has made
  entry_tag;
  // why the trade being placed is not a plain fresh pick
  hook_release = false;
  // the next live entry was just released by the virtual hook (only those fire both sides)
  last_live_at = 0;
  // when the last live buy went out (pacing)
  hook_pending = false;
  // a real loss just happened: the next entry is paper-traded first (virtual hook)
  trade_count = 0;
  // settled trades in this run (capital protection counts these)
  flip_origin = null;
  // auto flip: the contract we flipped away from
  blocked = /* @__PURE__ */ new Map();
  // symbol|type -> until: no trend confirmed on the 1-tick chart yet
  constructor(connection, currency, config, getSnapshots, onEvent, learner, hooks) {
    this.learner = learner;
    this.hooks = hooks;
    this.connection = connection;
    this.currency = currency;
    this.config = config;
    this.getSnapshots = getSnapshots;
    this.onEvent = onEvent;
    this.connection.onFatalError = () => this._emit({ phase: "error", error: "Lost connection to Deriv" });
    this.connection.onReconnecting = () => this.hooks?.onLog?.("info", "Connection to Deriv dropped; reconnecting...");
    this.connection.onReconnect = () => this.hooks?.onLog?.("success", "Reconnected to Deriv. Any open contract is being re-checked.");
  }
  /** The virtual-hook rules are the active logic (hook on, mode 'hook'): no auto flip, no switching, paper first, live after proof. */
  _hookMode() {
    return !!this.config.virtual_hook && (this.config.virtual_mode ?? "hook") === "hook";
  }
  start() {
    this.running = true;
    this.step = 1;
    this.total_profit = 0;
    this.consecutive_losses = 0;
    this.win_streak = 0;
    this.streak_profit = 0;
    this.busy = false;
    this.trade_count = 0;
    this.last_live_at = 0;
    this.hook_pending = this._hookMode();
    this.flip_origin = null;
    this.blocked.clear();
    this._emit({ phase: "started" });
    this._findAndEnter(this.config.stake);
  }
  /** True from start() until stop(). The AI tab reads this to re-attach to a run that kept going while the tab was closed. */
  get isRunning() {
    return this.running;
  }
  stop(reason = "stopped by user") {
    this.running = false;
    this._emit({ phase: "stopped", reason });
  }
  _emit(event) {
    this.onEvent({
      ts: Date.now(),
      total_profit: this.total_profit,
      step: this.step,
      ...event
    });
  }
  /** The best tradable contract right now (learner-guided when learning is on). Risk style plays no part in this. */
  _pick(raw_snapshots) {
    const gated = applyGate(raw_snapshots, this.hooks?.gate?.());
    const now = Date.now();
    const unblocked = {};
    for (const [symbol, snap] of Object.entries(gated)) {
      unblocked[symbol] = {
        ...snap,
        signals: snap.signals.filter((sig) => (this.blocked.get(`${symbol}|${sig.contract_type}`) ?? 0) <= now)
      };
    }
    const allowed = this._allowedTypes();
    let pool = unblocked;
    if (allowed) {
      pool = {};
      for (const [symbol, snap] of Object.entries(unblocked)) pool[symbol] = { ...snap, signals: snap.signals.filter((sig) => allowed.has(sig.contract_type)) };
    }
    const wants_longer = !!allowed && ["ONETOUCH", "NOTOUCH", "RUNHIGH", "RUNLOW"].some((t) => allowed.has(t));
    const snapshots = wants_longer ? pool : preferOneTick(pool);
    const learner = this.learner && this.learner.mode !== "off" ? this.learner : void 0;
    return learner ? learner.pickBest(candidatesFromSnapshots(snapshots, AUTOPILOT_CONTRACT_TYPES)) : pickBestGlobalCandidate(snapshots, !wants_longer);
  }
  /** The best tradable contract that is NOT the one that just lost (nor its opposite side). Null if there is none. */
  _pickSwitch(lost) {
    const skip = new Set([lost.contract_type, FLIP_PARTNER[lost.contract_type]].filter(Boolean));
    const snapshots = this.getSnapshots();
    const others = {};
    for (const [symbol, snap] of Object.entries(snapshots)) {
      others[symbol] = { ...snap, signals: snap.signals.filter((sig) => !skip.has(sig.contract_type)) };
    }
    return this._pick(others);
  }
  /** Entry reader on: the contract and the market come from the latest ticks. Nothing readable -> the classic pick below. */
  _findAndEnter(stake, tag) {
    if (!this.running || this.busy) return;
    if (this.config.read_entries === true) {
      this.busy = true;
      void this._bestByReading(null).then((best) => {
        this.busy = false;
        if (!this.running) return;
        if (best) {
          this._enter(best, stake, tag);
          return;
        }
        this._findAndEnterClassic(stake, tag);
      });
      return;
    }
    this._findAndEnterClassic(stake, tag);
  }
  _findAndEnterClassic(stake, tag) {
    if (!this.running || this.busy) return;
    const learner = this.learner && this.learner.mode !== "off" ? this.learner : void 0;
    const candidate = this._pick(this.getSnapshots());
    if (!candidate && this._hookMode() && this._allowedTypes()) {
      this.busy = true;
      void this._nextHookCandidate(null).then((c) => {
        this.busy = false;
        if (!this.running) return;
        if (c) this._enter(c, stake, tag);
        else setTimeout(() => this._findAndEnter(stake, tag), 1500);
      });
      return;
    }
    if (!candidate) {
      if (Date.now() - this.last_wait_emit > 3e4) {
        this.last_wait_emit = Date.now();
        this._emit({
          phase: "waiting",
          reason: learner?.mode === "edge_gate" ? "no market/contract has a proven edge yet" : "no market has a tradable 1-tick signal right now (contracts Deriv refused or priced too low are skipped)"
        });
      }
      setTimeout(() => this._findAndEnter(stake, tag), 1500);
      return;
    }
    this._enter(candidate, stake, tag);
  }
  /** The contract types the ticked families allow, or null when no restriction is set. */
  _allowedTypes() {
    const keys = this.config.contract_families;
    if (!keys) return null;
    return new Set(CONTRACT_FAMILIES.filter((f) => keys.includes(f.key)).flatMap((f) => f.types));
  }
  /**
   * Hook rules, contract rotation: the candidate for the NEXT paper test. With rotation on (default) and more than one family
   * ticked, it is the next ticked family after the one just traded, on the market with the best signal for it (or the same
   * market when there is none). Rise/Fall and Only Ups/Downs take the side the 1-tick chart confirms (higher-high -> Rise /
   * Only Ups, lower-low -> Fall / Only Downs); with no trend that family is skipped this round. Null = keep the same contract.
   */
  async _nextHookCandidate(prev) {
    const keys = this.config.contract_families;
    const families = CONTRACT_FAMILIES.filter((f) => !keys || keys.includes(f.key));
    if (!families.length) return null;
    if (prev && (!keys || this.config.rotate_contracts === false || families.length < 2)) return null;
    if (this.config.read_entries === true) {
      const best = await this._bestByReading(prev);
      if (!this.running) return null;
      if (best) return best;
    }
    const start = prev ? families.findIndex((f) => f.types.includes(prev.contract_type)) : -1;
    for (let i = 1; i <= families.length; i++) {
      const family = families[(start + i + families.length) % families.length];
      const candidate = await this._candidateForFamily(family, prev?.symbol);
      if (!this.running) return null;
      if (candidate) return candidate;
    }
    return null;
  }
  /**
   * Entry reader. Reads the latest ticks of every market for every ticked contract and returns the contract whose entry is
   * closest to firing (see entryScore). Signal confidence is not used. Rise/Fall and Only Ups/Downs need their trend first;
   * Touch / No Touch need Deriv to price them. Ties go to the family after the one just traded, so every contract gets turns.
   */
  async _bestByReading(prev) {
    const keys = this.config.contract_families;
    let families = CONTRACT_FAMILIES.filter((f) => !keys || keys.includes(f.key));
    if (!families.length) return null;
    if (prev) {
      const at = families.findIndex((f) => f.types.includes(prev.contract_type));
      if (at >= 0) families = [...families.slice(at + 1), ...families.slice(0, at + 1)];
    }
    const symbols = Object.keys(this.getSnapshots());
    if (!symbols.length) return null;
    const target = Math.min(MAX_ENTRY_TICK, Math.max(MIN_ENTRY_TICK, Math.floor(this.config.entry_tick ?? DEFAULT_ENTRY_TICK)));
    const history = /* @__PURE__ */ new Map();
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const res = await this.connection.send({ ticks_history: symbol, count: Math.max(30, TREND_WINDOW), end: "latest", style: "ticks" });
          const prices = (res?.history?.prices ?? []).map(Number).filter(Number.isFinite);
          history.set(symbol, { prices, pip: Number.isInteger(res?.pip_size) ? Number(res.pip_size) : 2 });
        } catch {
        }
      })
    );
    if (!this.running) return null;
    const now = Date.now();
    const scored = [];
    let order = 0;
    for (const family of families) {
      for (const symbol of symbols) {
        const h = history.get(symbol);
        if (!h || h.prices.length < 11) continue;
        for (const type of family.types) {
          if (tradeTicks(symbol, type) === null) continue;
          if ((this.blocked.get(`${symbol}|${type}`) ?? 0) > now) continue;
          const need = TREND_NEEDED[type];
          if (need && detectTrend(h.prices.slice(-TREND_WINDOW)) !== need) continue;
          const prediction = type === "DIGITOVER" ? 4 : type === "DIGITUNDER" ? 5 : void 0;
          scored.push({ score: entryScore(type, prediction, h.prices, h.pip, target), symbol, type, order: order++ });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    for (const pick of scored.slice(0, 8)) {
      if (isTouch(pick.type) && !await this._probeTouch(pick.symbol, pick.type)) {
        if (!this.running) return null;
        continue;
      }
      const ticks = tradeTicks(pick.symbol, pick.type);
      if (ticks === null) continue;
      const kind = pick.type.startsWith("DIGIT") ? "digits" : isTouch(pick.type) ? "touch" : pick.type.startsWith("RUN") ? "only_up_down" : "rise_fall";
      this.hooks?.onLog?.("info", `Entry reader: ${OPPOSITE_LABEL[pick.type] ?? pick.type} on ${pick.symbol} reads best from the latest ticks (score ${pick.score.toFixed(2)}).`);
      return {
        symbol: pick.symbol,
        family: kind,
        contract_type: pick.type,
        duration_ticks: ticks,
        prediction: pick.type === "DIGITOVER" ? 4 : pick.type === "DIGITUNDER" ? 5 : isTouch(pick.type) ? TOUCH_BARRIER : void 0,
        label: OPPOSITE_LABEL[pick.type] ?? pick.type,
        confidence: 1,
        basis: "Entry reader: chosen from the latest ticks."
      };
    }
    return null;
  }
  /** Touch / No Touch entry: resolves true the moment the latest ticks fit the contract (a fast market for Touch, a calm one for No Touch). */
  async _awaitReading(candidate) {
    const type = candidate.contract_type;
    let buffer = [];
    let last_epoch;
    try {
      const res = await this.connection.send({ ticks_history: candidate.symbol, count: 30, end: "latest", style: "ticks" });
      buffer = (res?.history?.prices ?? []).map(Number).filter(Number.isFinite);
      const times = (res?.history?.times ?? []).map(Number).filter(Number.isFinite);
      last_epoch = times[times.length - 1];
    } catch {
      return false;
    }
    if (touchReading(type, buffer)) return true;
    return new Promise((resolve) => {
      let done = false;
      let sub = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (sub !== null) void this.connection.unsubscribe(sub);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 9e4);
      sub = this.connection.subscribe({ ticks: candidate.symbol }, (data, err) => {
        if (done) return;
        if (err || !this.running) return finish(false);
        const tick = data?.tick;
        if (!tick) return;
        const epoch = Number(tick.epoch);
        if (Number.isFinite(epoch)) {
          if (last_epoch !== void 0 && epoch <= last_epoch) return;
          last_epoch = epoch;
        }
        const q = Number(tick.quote);
        if (!Number.isFinite(q)) return;
        buffer = [...buffer, q].slice(-30);
        if (touchReading(type, buffer)) finish(true);
      });
    });
  }
  async _candidateForFamily(family, prefer_symbol) {
    const snapshots = this.getSnapshots();
    const symbols = Object.keys(snapshots).filter((sym) => family.types.some((t) => tradeTicks(sym, t) !== null));
    if (!symbols.length) return null;
    let best_real = null;
    for (const sym of symbols) {
      for (const sig of snapshots[sym].signals) {
        if (family.types.includes(sig.contract_type) && (!best_real || sig.confidence > best_real.confidence)) best_real = { symbol: sym, ...sig };
      }
    }
    let symbol = best_real?.symbol ?? (prefer_symbol && symbols.includes(prefer_symbol) ? prefer_symbol : symbols[0]);
    let type = best_real?.contract_type ?? family.types[0];
    if (isTouch(type)) {
      let priced = null;
      for (const sym of [symbol, ...symbols.filter((s) => s !== symbol)].slice(0, 6)) {
        if (await this._probeTouch(sym, type)) {
          priced = sym;
          break;
        }
        if (!this.running) return null;
      }
      if (!priced) return null;
      symbol = priced;
    }
    if (family.trend) {
      let trend = "none";
      try {
        const res = await this.connection.send({ ticks_history: symbol, count: TREND_WINDOW, end: "latest", style: "ticks" });
        trend = detectTrend((res?.history?.prices ?? []).map(Number).filter(Number.isFinite));
      } catch {
        trend = "none";
      }
      if (trend === "none") return null;
      type = trend === "bullish" ? family.types[0] : family.types[1];
    }
    const ticks = tradeTicks(symbol, type);
    if (ticks === null) return null;
    if (best_real && best_real.contract_type === type && best_real.symbol === symbol) return { ...best_real, symbol, duration_ticks: ticks };
    const kind = type.startsWith("DIGIT") ? "digits" : type === "ONETOUCH" || type === "NOTOUCH" ? "touch" : type.startsWith("RUN") ? "only_up_down" : "rise_fall";
    return {
      symbol,
      family: kind,
      contract_type: type,
      duration_ticks: ticks,
      prediction: type === "DIGITOVER" ? 4 : type === "DIGITUNDER" ? 5 : type === "ONETOUCH" || type === "NOTOUCH" ? TOUCH_BARRIER : void 0,
      label: OPPOSITE_LABEL[type] ?? type,
      confidence: 1,
      basis: "Contract rotation: the next ticked contract gets its paper test."
    };
  }
  /**
   * Touch / No Touch: asks Deriv for a price before any paper or live trade. A barrier of 0.5 can be too far (No Touch) or too
   * near (Touch) on a quiet market, and Deriv then answers "This contract offers no return". 5 ticks is tried first, then 10 ticks
   * with the same 0.5 barrier; if neither prices, the market/contract is skipped for 6 hours. True = priced and safe to use.
   */
  async _probeTouch(symbol, type) {
    const key = `${symbol}|${type}`;
    const first = touch_ticks.get(key) ?? 5;
    for (const ticks of first === 5 ? [5, 10] : [first]) {
      try {
        const res = await this.connection.send({
          proposal: 1,
          amount: this.config.stake,
          basis: "stake",
          contract_type: type,
          currency: this.currency,
          underlying_symbol: symbol,
          duration: ticks,
          duration_unit: "t",
          barrier: TOUCH_BARRIER
        });
        const ask = Number(res?.proposal?.ask_price);
        const payout = Number(res?.proposal?.payout);
        if (!res?.proposal || ask > 0 && payout > 0 && payout / ask < MIN_PAYOUT_RATIO) throw new Error("payout does not beat the stake");
        if (ticks !== 5) touch_ticks.set(key, ticks);
        else touch_ticks.delete(key);
        return true;
      } catch (err) {
        if (!this.running) return false;
        this.hooks?.onLog?.("info", `${OPPOSITE_LABEL[type] ?? type} on ${symbol} for ${ticks} tick(s), barrier ${TOUCH_BARRIER}: ${err instanceof Error ? err.message : "not priced"}`);
      }
    }
    markRefused(symbol, type);
    this.hooks?.onLog?.("info", `${OPPOSITE_LABEL[type] ?? type} has no usable price on ${symbol} (5 or 10 ticks, barrier ${TOUCH_BARRIER}). Skipping it for 6 hours.`);
    return false;
  }
  /** Hook rules: after a live trade, paper-test the next contract (rotation) or the same one again. */
  _hookNext(candidate, stake, tag) {
    this.busy = true;
    void this._nextHookCandidate(candidate).then((next) => {
      this.busy = false;
      if (!this.running) return;
      this._enter(next ?? candidate, stake, tag);
    });
  }
  /** Rise/Fall: bought only once the 1-tick chart shows a higher high (Rise) or a lower low (Fall). */
  async _trendOk(candidate) {
    const need = TREND_NEEDED[candidate.contract_type];
    if (!need) return true;
    try {
      const res = await this.connection.send({ ticks_history: candidate.symbol, count: TREND_WINDOW, end: "latest", style: "ticks" });
      const prices = (res?.history?.prices ?? []).map(Number).filter(Number.isFinite);
      return detectTrend(prices) === need;
    } catch {
      return false;
    }
  }
  /**
   * Two-tick entry. Resolves true at the exact moment the matching run reaches `entry_tick` ticks (default 3: two agreeing ticks
   * and the buy on the third), straight from the live tick stream. A run that is already past that length does not count, so the
   * AI never buys on the 4th or 5th tick of the same run; it waits for the run to break and a new one to build. Resolves false
   * after about 90 ticks (the caller then picks something else).
   */
  async _awaitEntryTick(candidate) {
    const target = Math.min(MAX_ENTRY_TICK, Math.max(MIN_ENTRY_TICK, Math.floor(this.config.entry_tick ?? DEFAULT_ENTRY_TICK)));
    const type = candidate.contract_type;
    if (isTouch(type)) return this._awaitReading(candidate);
    const prediction = candidate.prediction;
    let pip = 2;
    let run = 0;
    let prev;
    let last_epoch;
    try {
      const res = await this.connection.send({ ticks_history: candidate.symbol, count: target + 2, end: "latest", style: "ticks" });
      const prices = (res?.history?.prices ?? []).map(Number).filter(Number.isFinite);
      const times = (res?.history?.times ?? []).map(Number).filter(Number.isFinite);
      if (Number.isInteger(res?.pip_size)) pip = Number(res.pip_size);
      if (tickAgrees(type, prediction, prices[prices.length - 1] ?? 0, void 0, pip) === null) return true;
      run = trailingRun(type, prediction, prices, pip);
      prev = prices[prices.length - 1];
      last_epoch = times[times.length - 1];
    } catch {
      return false;
    }
    return new Promise((resolve) => {
      let done = false;
      let sub = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (sub !== null) void this.connection.unsubscribe(sub);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 18e4);
      const wait_ticks = Math.min(MAX_ENTRY_WAIT_TICKS, Math.max(MIN_ENTRY_WAIT_TICKS, Math.floor(this.config.entry_wait_ticks ?? DEFAULT_ENTRY_WAIT_TICKS)));
      let seen = 0;
      sub = this.connection.subscribe({ ticks: candidate.symbol }, (data, err) => {
        if (done) return;
        if (err || !this.running) return finish(false);
        const tick = data?.tick;
        if (!tick) return;
        const epoch = Number(tick.epoch);
        if (Number.isFinite(epoch)) {
          if (last_epoch !== void 0 && epoch <= last_epoch) return;
          last_epoch = epoch;
        }
        const q = Number(tick.quote);
        if (!Number.isFinite(q)) return;
        if (Number.isInteger(Number(tick.pip_size))) pip = Number(tick.pip_size);
        const a = tickAgrees(type, prediction, q, prev, pip);
        prev = q;
        run = a ? run + 1 : 0;
        seen += 1;
        if (run === target) return finish(true);
        if (seen >= wait_ticks) finish(false);
      });
    });
  }
  /** Follow-the-stream rule: true when the latest ticks already point the contract's way (or no rule applies). */
  async _streamOk(candidate) {
    if (this.config.follow_stream !== true) return true;
    const n = Math.min(MAX_FOLLOW_TICKS, Math.max(1, Math.floor(this.config.follow_ticks ?? DEFAULT_FOLLOW_TICKS)));
    try {
      const res = await this.connection.send({ ticks_history: candidate.symbol, count: n + 1, end: "latest", style: "ticks" });
      const prices = (res?.history?.prices ?? []).map(Number).filter(Number.isFinite);
      const pip = Number.isInteger(res?.pip_size) ? Number(res.pip_size) : 2;
      const ok = followsStream(candidate.contract_type, candidate.prediction, prices, pip, n);
      return ok === null ? true : ok;
    } catch {
      return false;
    }
  }
  /** One auto-flip step: the partner after a loss, the original after the next one. Null when flipping is off / blocked. */
  _autoFlipTarget(candidate) {
    if (!this.config.auto_flip) return null;
    const target = this.flip_origin ?? partnerCandidate(candidate.symbol, candidate);
    const came_back = !!this.flip_origin;
    this.flip_origin = came_back ? null : candidate;
    return target;
  }
  /** One paper trade on live ticks: resolves true (win), false (loss) or null (could not be settled). No money moves. */
  _paperTrade(candidate) {
    const type = candidate.contract_type;
    const needed = isTouch(type) ? touch_ticks.get(`${candidate.symbol}|${type}`) ?? 5 : type === "RUNHIGH" || type === "RUNLOW" ? tradeTicks(candidate.symbol, type) ?? 2 : 1;
    return new Promise((resolve) => {
      const quotes = [];
      let pip = 2;
      let done = false;
      let sub = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (sub !== null) void this.connection.unsubscribe(sub);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), 45e3);
      sub = this.connection.subscribe({ ticks: candidate.symbol }, (data, err) => {
        if (done) return;
        if (err || !this.running) return finish(null);
        const tick = data?.tick;
        if (!tick) return;
        quotes.push(Number(tick.quote));
        if (Number.isFinite(Number(tick.pip_size))) pip = Number(tick.pip_size);
        if (quotes.length < 2) return;
        const result = paperOutcome(type, quotes[1], quotes.slice(2), pip, needed);
        if (result !== null) finish(result);
      });
    });
  }
  /**
   * Real trading is paused after a loss. The contract the AI wants to trade next is paper-traded on live ticks and must
   * win `virtual_confirmations` paper trades IN A ROW (default 2). A paper loss resets the count and switches contract
   * (like real trades do), which then has to win its own run. Once a contract has passed, it is the one traded for
   * real, on the same market, at the stake it would have used. Every paper result is also given to the learner.
   */
  async _virtualHook(first, resume_stake) {
    this.busy = true;
    const hook_mode = this._hookMode();
    const needed = hook_mode ? 1 : Math.min(MAX_VIRTUAL_CONFIRMATIONS, Math.max(1, Math.floor(this.config.virtual_confirmations ?? DEFAULT_VIRTUAL_CONFIRMATIONS)));
    const opposite_mode = (this.config.virtual_mode ?? "hook") === "opposite";
    let via_opposite = false;
    this.hooks?.onLog?.(
      "info",
      hook_mode ? `Virtual hook: ${first.label} on ${first.symbol} is paper-traded first. A paper win buys ${first.label} for real; a paper loss buys the opposite (Even/Odd instead stays on paper until it wins) (stake ${resume_stake}).` : opposite_mode ? `Virtual hook: real trading paused after a loss. ${first.label} on ${first.symbol} is paper-traded; when a paper trade loses, the opposite contract is bought for real at stake ${resume_stake}.` : `Virtual hook: real trading paused after a loss. ${first.label} on ${first.symbol} must win ${needed} paper trade${needed === 1 ? "" : "s"} in a row before it is traded for real again at stake ${resume_stake}.`
    );
    this._emit({ phase: "virtual", virtual_state: "start", virtual_losses: 0, virtual_wins: 0, virtual_needed: needed, symbol: first.symbol, label: first.label, contract_type: first.contract_type });
    let candidate = first;
    let losses = 0;
    let wins = 0;
    let failures = 0;
    let trend_waits = 0;
    let confirmed = null;
    while (this.running) {
      this._emit({
        phase: "virtual",
        virtual_state: "paper",
        virtual_losses: losses,
        virtual_wins: wins,
        virtual_needed: needed,
        symbol: candidate.symbol,
        contract_type: candidate.contract_type,
        label: candidate.label
      });
      if (!await this._trendOk(candidate)) {
        if (!this.running) return;
        trend_waits += 1;
        if (trend_waits <= 20) {
          await sleep(1500);
          continue;
        }
        trend_waits = 0;
        const other = this._pick(this.getSnapshots());
        if (other) {
          candidate = other;
          wins = 0;
        }
        continue;
      }
      trend_waits = 0;
      const result = await this._paperTrade(candidate);
      if (!this.running) return;
      if (result === null) {
        failures += 1;
        if (failures >= 3) break;
        await sleep(1e3);
        continue;
      }
      failures = 0;
      this.learner?.recordVirtual(candidate.contract_type, result);
      wins = result ? wins + 1 : 0;
      if (!result) losses += 1;
      this._emit({
        phase: "virtual",
        virtual_state: "result",
        virtual_losses: losses,
        virtual_wins: wins,
        virtual_needed: needed,
        symbol: candidate.symbol,
        contract_type: candidate.contract_type,
        label: candidate.label,
        result: result ? "win" : "loss"
      });
      if (hook_mode) {
        if (!result && FOLLOW_HOOK_TYPES.has(candidate.contract_type)) {
          if (losses >= MAX_FOLLOW_PAPER_LOSSES) {
            this.hooks?.onLog?.("info", `Virtual hook: ${candidate.label} lost ${losses} paper trades in a row; picking a fresh contract to paper-test.`);
            this.hook_pending = true;
            break;
          }
          this.hooks?.onLog?.("info", `Virtual loss on ${candidate.label} (${candidate.symbol}): staying on paper until it wins, then trading it for real.`);
          continue;
        }
        if (!result) {
          confirmed = pickFlipCandidate(this.getSnapshots(), candidate.symbol, candidate);
          confirmed = { ...confirmed, label: OPPOSITE_LABEL[confirmed.contract_type] ?? confirmed.label, basis: `Virtual hook: paper ${candidate.label} lost, buying the opposite.` };
          via_opposite = true;
          this.hooks?.onLog?.("info", `Virtual loss on ${candidate.label} (${candidate.symbol}): buying the opposite, ${confirmed.label}, for real.`);
          break;
        }
        if (wins >= needed) {
          confirmed = candidate;
          this.hooks?.onLog?.("success", `Virtual hook: ${candidate.label} on ${candidate.symbol} won ${wins} paper trade${wins === 1 ? "" : "s"} in a row: trading it for real now.`);
          break;
        }
        continue;
      }
      if (opposite_mode) {
        if (!result) {
          confirmed = pickFlipCandidate(this.getSnapshots(), candidate.symbol, candidate);
          confirmed = { ...confirmed, label: OPPOSITE_LABEL[confirmed.contract_type] ?? confirmed.label, basis: `Virtual hook: paper ${candidate.label} lost, buying the opposite.` };
          this.hooks?.onLog?.("info", `Virtual loss on ${candidate.label} (${candidate.symbol}): buying the opposite, ${confirmed.label}, for real.`);
          break;
        }
        if (wins >= MAX_OPPOSITE_PAPER_WINS) {
          this.hooks?.onLog?.("info", `Virtual hook: ${wins} paper wins in a row on ${candidate.label}; no loss to trade against. Picking a fresh contract.`);
          break;
        }
        this.hooks?.onLog?.("info", `Virtual win ${wins} on ${candidate.label} (${candidate.symbol}); still paper trading, waiting for a paper loss.`);
        continue;
      }
      if (result) {
        if (wins >= needed) {
          confirmed = candidate;
          this.hooks?.onLog?.("success", `Virtual hook: ${candidate.label} on ${candidate.symbol} won ${wins} paper trade${wins === 1 ? "" : "s"} in a row: trading it for real now.`);
          break;
        }
        this.hooks?.onLog?.("info", `Virtual win ${wins}/${needed} on ${candidate.label} (${candidate.symbol}); confirming again before going live.`);
        continue;
      }
      this.hooks?.onLog?.("info", `Virtual loss #${losses} on ${candidate.label} (${candidate.symbol}); the count restarts on the next contract.`);
      candidate = this._autoFlipTarget(candidate) ?? this._pick(this.getSnapshots()) ?? candidate;
    }
    this.flip_origin = null;
    this.busy = false;
    if (this.running) {
      this._emit({ phase: "virtual", virtual_state: "end", virtual_losses: losses, virtual_wins: wins, virtual_needed: needed });
      if (confirmed) {
        this.hook_release = true;
        this._enter(confirmed, resume_stake, opposite_mode || via_opposite ? "flipped" : void 0);
      } else this._findAndEnter(resume_stake);
    }
  }
  _enter(candidate, wanted_stake, tag, waits = 0) {
    if (this.hook_pending) {
      this.hook_pending = false;
      if (PAPER_SUPPORTED.has(candidate.contract_type)) {
        if (isTouch(candidate.contract_type)) {
          this.busy = true;
          void this._probeTouch(candidate.symbol, candidate.contract_type).then((ok) => {
            this.busy = false;
            if (!this.running) return;
            if (ok) {
              void this._virtualHook(candidate, wanted_stake);
            } else {
              this.hook_pending = true;
              setTimeout(() => this._findAndEnter(wanted_stake, tag), 300);
            }
          });
          return;
        }
        void this._virtualHook(candidate, wanted_stake);
        return;
      }
      this.hooks?.onLog?.("info", `Virtual hook skipped: ${candidate.label} cannot be paper-traded.`);
    }
    const stream_rule = this.config.follow_stream === true && followsStream(candidate.contract_type, candidate.prediction, [], 2, 1) !== null;
    if (stream_rule) {
      const target = Math.min(MAX_ENTRY_TICK, Math.max(MIN_ENTRY_TICK, Math.floor(this.config.entry_tick ?? DEFAULT_ENTRY_TICK)));
      if (waits === 0) {
        this.hooks?.onLog?.("info", `Waiting on ${candidate.symbol} for ${target - 1} matching ticks in a row, then buying ${candidate.label} on tick ${target}${this.hook_release ? " (the virtual hook's decision)" : ""}.`);
      }
      this.busy = true;
      void this._awaitEntryTick(candidate).then(async (fired) => {
        const trend_ok = fired ? await this._trendOk(candidate) : false;
        this.busy = false;
        if (!this.running) return;
        if (fired && trend_ok) {
          this._enterNow(candidate, wanted_stake, tag);
          return;
        }
        this.hooks?.onLog?.(
          "info",
          `No entry for ${candidate.label} on ${candidate.symbol} (${fired ? "the run completed without a confirmed trend" : `no matching run in ${Math.min(MAX_ENTRY_WAIT_TICKS, Math.max(MIN_ENTRY_WAIT_TICKS, Math.floor(this.config.entry_wait_ticks ?? DEFAULT_ENTRY_WAIT_TICKS)))} ticks`}): skipping it for ${NO_ENTRY_SKIP_MS / 1e3}s and picking another contract.`
        );
        this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + NO_ENTRY_SKIP_MS);
        this.hook_release = false;
        if (this._hookMode()) this.hook_pending = true;
        this._findAndEnter(wanted_stake, tag);
      });
      return;
    }
    if (!TREND_NEEDED[candidate.contract_type] && !stream_rule) {
      this._enterNow(candidate, wanted_stake, tag);
      return;
    }
    this.busy = true;
    void Promise.all([this._trendOk(candidate), this._streamOk(candidate)]).then(([trend_ok, stream_ok]) => {
      this.busy = false;
      if (!this.running) return;
      if (trend_ok && stream_ok) {
        this._enterNow(candidate, wanted_stake, tag);
        return;
      }
      const wait_limit = !stream_ok ? 45 : 20;
      if ((!stream_ok || tag === "flipped" || this._hookMode()) && waits < wait_limit) {
        if (waits === 0) {
          const n = Math.min(MAX_FOLLOW_TICKS, Math.max(1, Math.floor(this.config.follow_ticks ?? DEFAULT_FOLLOW_TICKS)));
          this.hooks?.onLog?.(
            "info",
            !stream_ok ? `Waiting for the last ${n} tick${n === 1 ? "" : "s"} on ${candidate.symbol} to follow the same way (${candidate.label}) before buying.` : `Waiting for a ${TREND_NEEDED[candidate.contract_type] === "bullish" ? "higher-high" : "lower-low"} trend on the 1-tick chart before ${candidate.label} on ${candidate.symbol}.`
          );
        }
        setTimeout(() => this._enter(candidate, wanted_stake, tag, waits + 1), !stream_ok ? 1e3 : 1500);
        return;
      }
      this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 6e3);
      this.hook_release = false;
      if (this._hookMode()) this.hook_pending = true;
      this._findAndEnter(wanted_stake, tag);
    });
  }
  _enterNow(candidate_in, wanted_stake_in, tag) {
    const candidate = candidate_in;
    const per_hour = Math.floor(this.config.max_trades_per_hour ?? 0);
    if (per_hour > 0 && this.last_live_at > 0) {
      const wait_ms = this.last_live_at + 36e5 / per_hour - Date.now();
      if (wait_ms > 0) {
        this.busy = true;
        setTimeout(() => {
          this.busy = false;
          if (!this.running) return;
          this._enterNow(candidate, wanted_stake_in, tag);
        }, Math.min(wait_ms, 6e4) + 5);
        return;
      }
    }
    if (this.learner?.mode === "edge_gate" && !this.learner.isTradable(candidate.symbol, candidate.contract_type, candidate.bucket, candidate.duration_ticks)) {
      this.hook_release = false;
      if (Date.now() - this.last_wait_emit > 3e4) {
        this.last_wait_emit = Date.now();
        this.hooks?.onLog?.("info", `Standing aside: ${candidate.label} has no proven edge over its payout, so no real money is staked. Paper trading continues.`);
        this._emit({ phase: "waiting", reason: "no contract has a proven edge yet: standing aside (paper trading only)" });
      }
      if (this._hookMode()) this.hook_pending = true;
      setTimeout(() => this._findAndEnter(wanted_stake_in, tag), 4e3);
      return;
    }
    const from_hook = this.hook_release;
    this.hook_release = false;
    const protect = Math.max(0, Math.floor(this.config.protect_trades ?? 0));
    const wanted_stake = this.trade_count < protect ? Math.min(wanted_stake_in, this.config.stake) : wanted_stake_in;
    const governed = this.learner && this.step === 1 ? this.learner.governStake(wanted_stake, this.config.stake, candidate) : wanted_stake;
    const stake = governed;
    if (governed < wanted_stake) {
      this.hooks?.onLog?.("info", `Exploring ${candidate.contract_type} ${candidate.duration_ticks ?? ""}t: first stake capped at ${governed} (25% of base) until 20 results are in.`);
    }
    const live_balance = this.connection.accountInfo?.balance;
    if (typeof live_balance === "number" && Number.isFinite(live_balance) && stake > live_balance) {
      this.hooks?.onLog?.("error", `The next stake (${stake} ${this.currency}) is more than the account balance (${live_balance.toFixed(2)}). Stopping.`);
      this.stop("balance is too low for the next stake");
      return;
    }
    if (this.step === 1) this.ladder_spent = 0;
    this.ladder_spent = Number((this.ladder_spent + stake).toFixed(2));
    this.busy = true;
    this.lastCandidate = candidate;
    this.last_live_at = Date.now();
    this.entry_tag = tag;
    this._emit({
      phase: "entering",
      symbol: candidate.symbol,
      contract_type: candidate.contract_type,
      label: candidate.label,
      confidence: candidate.confidence,
      stake,
      tag
    });
    let parameters;
    try {
      parameters = buildTradeParameters(candidate, stake, this.currency);
    } catch (err) {
      this.busy = false;
      const detail = err instanceof Error ? err.message : "Could not build the trade";
      this.hooks?.onLog?.("error", detail);
      markRefused(candidate.symbol, candidate.contract_type);
      if (this.step === 1) this.ladder_spent = 0;
      else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
      if (this._hookMode()) this.hook_pending = true;
      setTimeout(() => this._findAndEnter(wanted_stake, tag), 500);
      return;
    }
    const tried_duration = Number(parameters.duration);
    let partner = null;
    let partner_parameters = null;
    if (this.config.both_sides !== false && bothSidesType(candidate.contract_type)) {
      const opposite_type = FLIP_PARTNER[candidate.contract_type];
      const live2 = this.connection.accountInfo?.balance;
      if (typeof live2 === "number" && Number.isFinite(live2) && stake * 2 > live2) {
        this.hooks?.onLog?.("info", `Both sides skipped: two stakes of ${stake} ${this.currency} are more than the balance (${live2.toFixed(2)}).`);
      } else if (opposite_type) {
        try {
          const opposite = { ...candidate, prediction: opposite_type === "DIGITOVER" ? 4 : opposite_type === "DIGITUNDER" ? 5 : candidate.prediction, contract_type: opposite_type, label: OPPOSITE_LABEL[opposite_type] ?? opposite_type, basis: `Both sides: ${candidate.label} and ${OPPOSITE_LABEL[opposite_type] ?? opposite_type}.` };
          partner_parameters = { ...buildTradeParameters(opposite, stake, this.currency), duration: tried_duration };
          partner = opposite;
        } catch (err) {
          this.hooks?.onLog?.("info", `Both sides skipped: ${err instanceof Error ? err.message : "the opposite contract could not be built"}`);
        }
      }
    }
    this.hooks?.onLog?.(
      "info",
      `Buying ${candidate.contract_type} on ${candidate.symbol}, ${tried_duration} tick(s), stake ${stake} ${this.currency}` + (candidate.prediction !== void 0 ? `, prediction ${candidate.prediction}` : "")
    );
    this.connection.send({ proposal: 1, ...parameters }).then((res) => {
      const quote = res?.proposal;
      if (!quote) throw new Error("Deriv returned no price for this contract");
      const ask = Number(quote.ask_price);
      const payout = Number(quote.payout);
      if (ask > 0 && payout > 0 && payout / ask < MIN_PAYOUT_RATIO) {
        throw Object.assign(new Error(`payout is only ${(payout / ask).toFixed(2)}x the stake`), { skip: true });
      }
      return this.connection.send({ buy: "1", price: stake, parameters });
    }).then(async (res) => {
      const contract_id = res?.buy?.contract_id;
      if (!contract_id) throw new Error("Buy did not return a contract id");
      if (!partner || !partner_parameters) {
        this._watch(candidate, stake, contract_id, tried_duration);
        return;
      }
      let partner_id = null;
      try {
        await this.connection.send({ proposal: 1, ...partner_parameters });
        const bought = await this.connection.send({ buy: "1", price: stake, parameters: partner_parameters });
        partner_id = bought?.buy?.contract_id ?? null;
      } catch (err) {
        this.hooks?.onLog?.("error", `Second side ${partner.label} could not be bought: ${err instanceof Error ? err.message : "refused"}. ${candidate.label} runs alone.`);
      }
      if (!partner_id) {
        this._watch(candidate, stake, contract_id, tried_duration);
        return;
      }
      this.ladder_spent = Number((this.ladder_spent + stake).toFixed(2));
      this.hooks?.onLog?.("info", `Both sides fired: ${candidate.label} + ${partner.label} on ${candidate.symbol}, stake ${stake} each.`);
      const pair = { pending: 2, profit: 0, stake: Number((stake * 2).toFixed(2)) };
      this._watch(candidate, stake, contract_id, tried_duration, pair);
      this._watch(partner, stake, partner_id, tried_duration, pair);
    }).catch((err) => {
      this.busy = false;
      const raw = String(err?.message || "Failed to place trade");
      if (/dropped/i.test(raw)) this.hooks?.onLog?.("error", "The connection dropped while buying. Check Transactions: that contract may still be open.");
      const detail = `${candidate.contract_type} on ${candidate.symbol} for ${tried_duration} tick(s): ${raw}`;
      this.hooks?.onLog?.("error", detail);
      const touch_key = `${candidate.symbol}|${candidate.contract_type}`;
      if (isTouch(candidate.contract_type) && tried_duration === 5 && !touch_ticks.has(touch_key) && /duration|tick|barrier|offered|no return|offers no/i.test(raw)) {
        touch_ticks.set(touch_key, 10);
        this.hooks?.onLog?.("info", `${candidate.label} refused at 5 ticks on ${candidate.symbol}; trying 10 ticks with the same 0.5 barrier.`);
        if (this.step === 1) this.ladder_spent = 0;
        else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
        setTimeout(() => this._enterNow(candidate, wanted_stake, tag), 300);
        return;
      }
      if ((err?.skip === true || REFUSAL_PATTERN.test(raw)) && this.refused < 8) {
        this.refused += 1;
        markRefused(candidate.symbol, candidate.contract_type);
        this.hooks?.onLog?.("info", `Skipping ${candidate.symbol} ${candidate.contract_type} for 6 hours and trying another.`);
        if (this.step === 1) this.ladder_spent = 0;
        else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
        if (this._hookMode()) this.hook_pending = true;
        setTimeout(() => this._findAndEnter(wanted_stake, tag), 500);
        return;
      }
      this._emit({ phase: "error", symbol: candidate.symbol, error: detail });
      this.stop("trade placement failed");
    });
  }
  _watch(candidate, stake, contract_id, duration, pair) {
    const entry_step = this.step;
    const entry_tag = this.entry_tag;
    const sub_id = this.connection.subscribe({ proposal_open_contract: 1, contract_id }, (data, err) => {
      if (err) {
        this.busy = false;
        this._emit({ phase: "error", symbol: candidate.symbol, error: err.message });
        this.stop("lost track of an open contract");
        return;
      }
      const contract = data?.proposal_open_contract;
      if (contract) this.hooks?.onContract?.(contract);
      if (!contract?.is_sold) return;
      this.refused = 0;
      this.connection.unsubscribe(sub_id);
      const profit = Number(contract.profit ?? 0);
      const won = profit > 0;
      this.hooks?.onLog?.(won ? "success" : "error", `${won ? "Won" : "Lost"} ${Math.abs(profit).toFixed(2)} ${this.currency} on ${candidate.symbol} ${candidate.contract_type}`);
      if (this.learner && this.learner.mode !== "off") {
        this.learner.record({
          symbol: candidate.symbol,
          contract_type: candidate.contract_type + (candidate.bucket ? `@${candidate.bucket}` : ""),
          duration,
          stake: Number(contract.buy_price ?? stake),
          profit,
          payout: Number(contract.payout ?? 0)
        });
      }
      this.total_profit = Number((this.total_profit + profit).toFixed(2));
      this.trade_count += 1;
      const bought = Number(contract.buy_price ?? stake);
      const now = Date.now();
      this.hooks?.onSettled?.({
        contract_id: String(contract_id),
        symbol: candidate.symbol,
        contract_type: candidate.contract_type,
        stake: bought,
        profit: Number(profit.toFixed(2)),
        payout: Number((bought + profit).toFixed(2)),
        buy_ts: Number(contract.date_start ?? contract.purchase_time ?? 0) * 1e3 || now,
        sell_ts: Number(contract.sell_time ?? contract.date_expiry ?? 0) * 1e3 || now,
        duration_ticks: duration,
        step: entry_step,
        base_stake: this.config.stake,
        mode: this.config.recovery_mode ?? "reverse",
        confidence: candidate.confidence,
        strategy: candidate.strategy,
        tag: entry_tag
      });
      this._emit({
        phase: "settled",
        symbol: candidate.symbol,
        contract_type: candidate.contract_type,
        result: won ? "win" : "loss",
        profit: Number(profit.toFixed(2))
      });
      let net_profit = profit;
      let net_stake = stake;
      if (pair) {
        pair.profit = Number((pair.profit + profit).toFixed(2));
        pair.pending -= 1;
        if (pair.pending > 0) return;
        net_profit = pair.profit;
        net_stake = pair.stake;
        this.hooks?.onLog?.(net_profit > 0 ? "success" : "error", `Both sides closed: net ${net_profit >= 0 ? "+" : ""}${net_profit.toFixed(2)} ${this.currency} on ${candidate.symbol}.`);
      }
      const net_won = net_profit > 0;
      this.busy = false;
      if (!this.running) return;
      if (this.total_profit <= -Math.abs(this.config.stop_loss)) {
        this.stop("stop loss reached");
        return;
      }
      if (this.total_profit >= this.config.take_profit) {
        this.stop("take profit reached");
        return;
      }
      const protect = Math.max(0, Math.floor(this.config.protect_trades ?? 0));
      if (protect > 0 && this.trade_count <= protect && this.total_profit <= -(this.config.stake * PROTECT_LOSS_STAKES)) {
        this.stop(`capital protection: lost ${PROTECT_LOSS_STAKES} base stakes in the first ${protect} trades`);
        return;
      }
      const mode = this.config.recovery_mode ?? "reverse";
      const base_stake = this.config.stake;
      if (net_won) {
        this.consecutive_losses = 0;
        this.flip_origin = null;
        const hook = this._hookMode();
        this.hook_pending = hook;
        const next = (next_stake3, tag) => hook ? this._hookNext(candidate, next_stake3, tag) : this._findAndEnter(next_stake3, tag);
        if (mode !== "reverse") {
          this.step = 1;
          next(base_stake);
          return;
        }
        this.win_streak += 1;
        this.streak_profit = Number((this.streak_profit + net_profit).toFixed(2));
        const max_streak = Math.max(1, Math.floor(this.config.max_streak ?? 3));
        if (this.win_streak >= max_streak) {
          this.hooks?.onLog?.("success", `${this.win_streak} wins in a row: gain banked, stake goes back to ${base_stake}.`);
          this.win_streak = 0;
          this.streak_profit = 0;
          this.step = 1;
          next(base_stake);
          return;
        }
        const growth = Math.max(1, this.config.streak_multiplier ?? 1.8);
        const next_stake2 = Number(Math.max(base_stake, Math.min(net_stake / (pair ? 2 : 1) * growth, base_stake + this.streak_profit)).toFixed(2));
        this.step = this.win_streak + 1;
        next(next_stake2, "streak");
        return;
      }
      const hook_rules = this._hookMode();
      this.hook_pending = !!this.config.virtual_hook;
      this.win_streak = 0;
      this.streak_profit = 0;
      this.consecutive_losses += 1;
      const must_switch = this.consecutive_losses >= SWITCH_AFTER_LOSSES;
      if (must_switch) this.consecutive_losses = 0;
      const switchTo = (next_stake2) => {
        if (hook_rules) return false;
        const target = this._autoFlipTarget(candidate);
        if (target) {
          this.hooks?.onLog?.("info", `Loss on ${candidate.label}: auto flip to ${target.label} on ${target.symbol}.`);
          this._enter(target, next_stake2, "flipped");
          return true;
        }
        if (!must_switch) return false;
        const alt = this._pickSwitch(candidate);
        if (!alt) {
          this.hooks?.onLog?.("info", `${SWITCH_AFTER_LOSSES} losses in a row on ${candidate.contract_type}, but no other contract is tradable right now.`);
          return false;
        }
        this.hooks?.onLog?.("info", `${SWITCH_AFTER_LOSSES} losses in a row on ${candidate.contract_type}: switching to ${alt.contract_type} on ${alt.symbol}.`);
        this._enter(alt, next_stake2, "switched");
        return true;
      };
      if (mode === "reverse" || mode === "flat") {
        this.step = 1;
        if (switchTo(base_stake)) return;
        if (hook_rules) {
          this._hookNext(candidate, base_stake);
          return;
        }
        this._findAndEnter(base_stake);
        return;
      }
      const recover = this.config.recover_losses === true && mode === "martingale";
      const shown_ratio = Number(contract.payout) / Number(contract.buy_price) - 1;
      const dropLadder = (why) => {
        this.hooks?.onLog?.("info", `Recovery ladder dropped (${why}): ${this.ladder_spent.toFixed(2)} ${this.currency} accepted as a loss, stake back to ${base_stake}.`);
        this.step = 1;
        this.ladder_spent = 0;
        if (hook_rules) this._hookNext(candidate, base_stake);
        else this._findAndEnter(base_stake);
      };
      if (this.step >= this.config.max_steps) {
        if (recover) {
          dropLadder(`${this.config.max_steps} steps lost`);
          return;
        }
        this.stop("max recovery steps reached");
        return;
      }
      const next_stake = recover ? recoveryStake(this.ladder_spent, base_stake, shown_ratio) : Number((net_stake / (pair ? 2 : 1) * this.config.martingale_multiplier).toFixed(2));
      if (this.ladder_spent + next_stake > Math.abs(this.config.stop_loss)) {
        if (recover) {
          dropLadder("the next stake would pass the stop-loss budget");
          return;
        }
        this.stop("recovery ladder would exceed the stop-loss budget");
        return;
      }
      if (recover) this.hooks?.onLog?.("info", `Recovery stake ${next_stake} ${this.currency}: wins back ${this.ladder_spent.toFixed(2)} lost plus one base stake.`);
      this.step += 1;
      if (switchTo(next_stake)) return;
      if (hook_rules) {
        this._hookNext(candidate, next_stake);
        return;
      }
      if (mode === "martingale") {
        this._enter(candidate, next_stake);
        return;
      }
      const flip = pickFlipCandidate(this.getSnapshots(), candidate.symbol, candidate);
      if (isBlocked(this.hooks?.gate?.(), flip.symbol, flip.contract_type, flip.strategy)) {
        this.hooks?.onLog?.("info", `The opposite side (${flip.contract_type}) is skipped: its own results are clearly negative. Picking another contract.`);
        this._findAndEnter(next_stake);
        return;
      }
      this._enter(flip, next_stake, "flipped");
    });
  }
};

// src/pages/bulk-trader/tradeHistory.ts
var mergeTradeRow = (rows, c) => {
  const id = String(c.contract_id ?? c.id ?? "");
  if (!id) return rows;
  const row = {
    id,
    ts: Number(c.date_start ?? c.purchase_time ?? Math.floor(Date.now() / 1e3)),
    symbol: String(c.underlying ?? c.display_name ?? ""),
    type: String(c.contract_type ?? ""),
    shortcode: String(c.shortcode ?? ""),
    tick_count: c.tick_count ? Number(c.tick_count) : void 0,
    stake: Number(c.buy_price ?? 0),
    profit: Number(c.profit ?? 0),
    open: !c.is_sold
  };
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return [row, ...rows].slice(0, 100);
  const next = [...rows];
  next[i] = row;
  return next;
};

// src/pages/bulk-trader/serverRun.ts
var emptyVirtual = () => ({ active: false, current: "", losses: 0, wins: 0, needed: 2, rows: [] });
var MAX_ACTIVITY = 60;
var MAX_CONTRACTS = 40;
var CONTRACT_FIELDS = [
  "contract_id",
  "id",
  "underlying",
  "display_name",
  "contract_type",
  "shortcode",
  "currency",
  "buy_price",
  "sell_price",
  "bid_price",
  "payout",
  "profit",
  "profit_percentage",
  "is_sold",
  "is_expired",
  "is_settleable",
  "status",
  "date_start",
  "date_expiry",
  "purchase_time",
  "sell_time",
  "entry_spot",
  "exit_spot",
  "entry_tick",
  "exit_tick",
  "entry_tick_time",
  "exit_tick_time",
  "transaction_ids",
  "transaction_id",
  "tick_count",
  "longcode",
  "barrier",
  "current_spot",
  "current_spot_time"
];
var trimContract = (c) => {
  const out = {};
  for (const k of CONTRACT_FIELDS) if (c[k] !== void 0) out[k] = c[k];
  return out;
};
var upsertContract = (rows, c) => {
  const id = String(c.contract_id ?? c.id ?? "");
  if (!id) return rows;
  const t = trimContract(c);
  const i = rows.findIndex((r) => String(r.contract_id ?? r.id) === id);
  if (i === -1) return [t, ...rows].slice(0, MAX_CONTRACTS);
  const next = [...rows];
  next[i] = t;
  return next;
};
var ServerRun = class {
  opts;
  engine = null;
  state;
  constructor(opts) {
    this.opts = opts;
    this.state = {
      status: "connecting",
      error: null,
      totalProfit: 0,
      ladder: [],
      history: [],
      contracts: [],
      activity: [],
      virtual: emptyVirtual(),
      started_at: Date.now(),
      updated_at: Date.now()
    };
  }
  getState() {
    return this.state;
  }
  get isRunning() {
    return !!this.engine?.isRunning;
  }
  patch(next) {
    this.state = { ...this.state, ...next, updated_at: Date.now() };
    try {
      this.opts.onChange?.(this.state);
    } catch {
    }
  }
  log(kind, text) {
    this.patch({ activity: [{ ts: Date.now(), kind, text }, ...this.state.activity].slice(0, MAX_ACTIVITY) });
  }
  /** Same reading of the engine's events as the AI tab's own handler. */
  onEvent = (event) => {
    const s = this.state;
    if (event.phase === "started") {
      this.patch({ status: "running", ladder: [], totalProfit: this.opts.carried_profit ?? 0, virtual: { ...s.virtual, active: false, current: "", losses: 0, wins: 0 } });
    } else if (event.phase === "virtual") {
      const what = `${event.label ?? event.contract_type ?? ""} on ${event.symbol ?? ""}`.trim();
      if (event.virtual_state === "result" && event.result) {
        const row = { ts: Date.now(), symbol: event.symbol ?? "", label: event.label ?? "", result: event.result };
        this.patch({
          virtual: {
            ...s.virtual,
            losses: event.virtual_losses ?? s.virtual.losses,
            wins: event.virtual_wins ?? s.virtual.wins,
            needed: event.virtual_needed ?? s.virtual.needed,
            rows: [row, ...s.virtual.rows].slice(0, 50)
          }
        });
      } else if (event.virtual_state === "end") {
        this.patch({ virtual: { ...s.virtual, active: false, current: "" } });
      } else {
        this.patch({
          virtual: {
            ...s.virtual,
            active: true,
            current: what,
            losses: event.virtual_losses ?? s.virtual.losses,
            wins: event.virtual_wins ?? s.virtual.wins,
            needed: event.virtual_needed ?? s.virtual.needed
          }
        });
      }
    } else if (event.phase === "entering" && event.symbol && event.contract_type) {
      this.patch({
        ladder: [
          ...s.ladder,
          { step: event.step || 1, symbol: event.symbol, label: event.label || event.contract_type, stake: event.stake || 0, tag: event.tag }
        ].slice(-200)
      });
    } else if (event.phase === "settled") {
      const ladder = s.ladder.map((r) => ({ ...r }));
      const last = ladder[ladder.length - 1];
      if (last) {
        last.result = event.result;
        last.profit = event.profit;
      }
      this.patch({ ladder, totalProfit: (this.opts.carried_profit ?? 0) + (event.total_profit ?? 0) });
    } else if (event.phase === "stopped") {
      this.patch({ status: "stopped", stopReason: event.reason, virtual: { ...s.virtual, active: false, current: "" } });
      this.log("info", `AI auto-pilot stopped: ${event.reason ?? "no reason given"}`);
      this.finish();
    } else if (event.phase === "error") {
      this.patch({ status: "error", error: event.error || "Something went wrong.", virtual: { ...s.virtual, active: false, current: "" } });
      this.finish();
    }
  };
  finish() {
    try {
      this.opts.connection.close();
    } catch {
    }
  }
  async start() {
    const { connection, currency, config, learnMode = "learn", getSnapshots, loginid } = this.opts;
    await loadLiveRules(Object.keys(getSnapshots()));
    const learner = new LearningEngine(await makeProfileId(loginid || "account"), learnMode);
    try {
      await learner.syncFromBackend();
      await learner.syncPaper();
    } catch {
    }
    learner.mode = learnMode;
    this.engine = new AutoPilotEngine(connection, currency, config, getSnapshots, this.onEvent, learner, {
      onContract: (contract) => this.patch({ history: mergeTradeRow(this.state.history, contract), contracts: upsertContract(this.state.contracts, contract) }),
      onLog: (kind, message) => this.log(kind, message),
      onSettled: (trade) => {
        try {
          this.opts.onSettled?.(trade);
        } catch {
        }
      }
    });
    this.log("info", "AI auto-pilot started on the server");
    this.engine.start();
  }
  stop(reason = "stopped by user") {
    if (this.engine?.isRunning) this.engine.stop(reason);
    else {
      this.patch({ status: "stopped", stopReason: reason });
      this.finish();
    }
  }
};
export {
  ServerRun,
  upsertContract
};
