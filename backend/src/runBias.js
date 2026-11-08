// Run bias. Pure and stateless: reads a rolling window of raw prices for ONE symbol and reports, for each contract,
// how often 2 or 3 (or more) ticks IN A ROW favoured it (a "run"), and whether such a run is happening right now.
//
// What counts as a tick in favour of a contract:
//   Even / Odd        the last digit is even / odd          (even 2,4,6   odd 1,3,7)
//   Over 4 / Under 5  the last digit is 5-9 / 0-4           (over 4: 5,8,9   under 5: 2,1,4)
//   Rise / Fall       the price moved up / down from the tick before
//   Only Up / Down    the same as Rise / Fall: a run of rising (falling) ticks is exactly what Only Ups (Only Downs) needs
//
// Per contract the report carries: runs (how many separate runs of the shortest analysed length appeared in the window), ticks_in_runs (how many ticks sat
// inside them), longest run, the CURRENT run length, and a bias in percent: that contract's share of all run ticks of the pair
// (Even vs Odd, Over 4 vs Under 5, Rise vs Fall, ...). 50 = balanced; the higher the number, the more the market is favouring it.
// An ENTRY signal is raised, per level (see LEVELS), when the current run has just reached that level AND the bias on that level is
// at least 50 + MIN_ENTRY_BIAS_EDGE.
//
// This is a description of the last few hundred ticks. Deriv's synthetic indices are random processes: a bias reading is not a
// validated edge, and every contract still pays less than 2x. The numbers are here so the AI has a consistent, fast signal.

import { detectTrend, TREND_WINDOW } from './trend.js';

export const MIN_RUN = 2; // the shortest run any contract is analysed on
export const RUN_WINDOW = 300; // ticks the bias is measured on (the freshest, so it follows the market)
export const MIN_RUN_SAMPLE = 60; // ticks needed before anything is reported
export const MIN_ENTRY_BIAS_EDGE = 5; // bias must be at least 55 for an entry signal
export const FRESH_SLACK = 1; // a level still fires when the run is at most this many ticks past it (a late poll), never on an old run
const MAX_EXTRA_SIGNALS = 3; // per symbol, besides the entry signals

/**
 * The run lengths each contract is analysed and fired on (the owner's rules):
 *   Even / Odd, Over 4 / Under 5   BOTH 2 and 3 consecutive ticks, every market, fire whenever a level's condition is met
 *   Only Ups / Only Downs          2 ticks and above (the AI fires both at the same time)
 *   Rise / Fall                    2 or more consecutive ticks
 */
/** Contracts that need a trend on the 1-tick chart before they may fire. */
export const TREND_NEEDED = { rise: 'bullish', only_up: 'bullish', fall: 'bearish', only_down: 'bearish' };

export const LEVELS = {
    even: [2, 3],
    odd: [2, 3],
    over4: [2, 3],
    under5: [2, 3],
    rise: [2],
    fall: [2],
    only_up: [2],
    only_down: [2],
};

export const RUN_CONTRACTS = [
    { key: 'even', contract_type: 'DIGITEVEN', label: 'Even', pair: 'odd', duration: 1 },
    { key: 'odd', contract_type: 'DIGITODD', label: 'Odd', pair: 'even', duration: 1 },
    { key: 'over4', contract_type: 'DIGITOVER', label: 'Over 4', pair: 'under5', duration: 1 },
    { key: 'under5', contract_type: 'DIGITUNDER', label: 'Under 5', pair: 'over4', duration: 1 },
    { key: 'rise', contract_type: 'CALL', label: 'Rise', pair: 'fall', duration: 1 },
    { key: 'fall', contract_type: 'PUT', label: 'Fall', pair: 'rise', duration: 1 },
    { key: 'only_up', contract_type: 'RUNHIGH', label: 'Only Ups', pair: 'only_down', duration: 2 },
    { key: 'only_down', contract_type: 'RUNLOW', label: 'Only Downs', pair: 'only_up', duration: 2 },
];

const round2 = n => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The number of decimal places a market really prints, read from its own prices. Deriv sends quotes as JSON numbers, so 100.50
 * arrives as 100.5: the trailing 0 is gone and the last digit would be read as 5. Every market has its own precision, and a wrong or
 * missing pip size silently turns every digit 0 into the digit before it. Across 60+ ticks at least one price shows its full precision
 * (the chance that none does is 0.1^60), so the largest number of decimals seen is the market's real precision.
 */
export const inferDecimals = prices => {
    let max = 0;
    for (const p of prices) {
        const t = String(Number(p));
        if (t.includes('e')) continue;
        const dot = t.indexOf('.');
        const d = dot < 0 ? 0 : t.length - dot - 1;
        if (d > max) max = d;
    }
    return max;
};

export const lastDigit = (price, decimals = 2) => {
    const fixed = Number(price).toFixed(Number.isInteger(decimals) ? decimals : 2);
    return Number(fixed[fixed.length - 1]);
};

/** For every tick of `prices` (index >= 1) and every contract: is that tick in favour? Returns { key: boolean[] } aligned to prices. */
export function favourFlags(prices, decimals = 2) {
    const n = prices.length;
    const flags = Object.fromEntries(RUN_CONTRACTS.map(c => [c.key, new Array(n).fill(false)]));
    for (let i = 0; i < n; i++) {
        const d = lastDigit(prices[i], decimals);
        flags.even[i] = d % 2 === 0;
        flags.odd[i] = d % 2 === 1;
        flags.over4[i] = d > 4;
        flags.under5[i] = d < 5;
        if (i === 0) continue;
        const move = prices[i] - prices[i - 1];
        flags.rise[i] = move > 0;
        flags.fall[i] = move < 0;
        flags.only_up[i] = move > 0;
        flags.only_down[i] = move < 0;
    }
    return flags;
}

/** Runs of >= minRun consecutive true flags: how many, how many ticks they hold, the longest, and the run that ends at the last tick. */
export function runStats(flag, minRun = MIN_RUN) {
    let runs = 0;
    let ticks_in_runs = 0;
    let longest = 0;
    let len = 0;
    let current_start = -1;
    const close = () => {
        if (len >= minRun) {
            runs += 1;
            ticks_in_runs += len;
        }
        if (len > longest) longest = len;
        len = 0;
    };
    for (let i = 0; i < flag.length; i++) {
        if (flag[i]) {
            if (len === 0) current_start = i;
            len += 1;
        } else if (len) close();
    }
    const current = len; // a run still open at the last tick
    close();
    return { runs, ticks_in_runs, longest, current, current_start: current ? current_start : -1 };
}

/**
 * THE ENTRY / EXIT TICKS. A pattern is complete on tick i (the last tick of the run). The AI buys right after it, so:
 *   entry tick = tick i + ENTRY_DELAY      (the first tick after the purchase)
 *   exit tick  = entry tick + duration     (1 tick for Even/Odd, Over/Under, Rise/Fall; 2 for Only Ups/Downs)
 * and the contract wins or loses on the EXIT tick:
 *   Even/Odd, Over 4/Under 5   the last digit of the exit tick (0 counts: even, and under 5)
 *   Rise/Fall                  exit price strictly above/below the entry price (a flat tick loses both)
 *   Only Ups/Downs             every tick after the entry rises/falls (one flat or reversed tick loses)
 * The history is replayed with exactly this rule, so each level reports how the contract really finished after the same pattern.
 */
export const ENTRY_DELAY = 1;
export const MIN_OUTCOME_SAMPLE = 10; // replays needed before the hit rate may veto an entry
export const BREAK_EVEN_PCT = 52; // these contracts pay about 1.9x the stake, so they must win about 52.6% to break even
const DURATION = Object.fromEntries(RUN_CONTRACTS.map(c => [c.key, c.duration]));
const NEEDS_BREAK_EVEN = new Set(['even', 'odd', 'over4', 'under5', 'rise', 'fall']); // Only Ups/Downs are bought as a pair: judged on the pair, not alone

/** Did `key` win when bought after the pattern ended on tick i? null when the history stops before the exit tick. */
export function settleAt(key, prices, i, decimals = 2) {
    const entry = i + ENTRY_DELAY;
    const exit = entry + DURATION[key];
    if (exit >= prices.length) return null;
    const digit = lastDigit(prices[exit], decimals);
    switch (key) {
        case 'even': return digit % 2 === 0;
        case 'odd': return digit % 2 === 1;
        case 'over4': return digit > 4;
        case 'under5': return digit < 5;
        case 'rise': return prices[exit] > prices[entry];
        case 'fall': return prices[exit] < prices[entry];
        case 'only_up': for (let t = entry + 1; t <= exit; t++) if (!(prices[t] > prices[t - 1])) return false; return true;
        case 'only_down': for (let t = entry + 1; t <= exit; t++) if (!(prices[t] < prices[t - 1])) return false; return true;
        default: return null;
    }
}

/** Replays the window: every time a run of this contract just reached `min_run` ticks (tick i), settle it and count wins. */
export function replayOutcomes(key, flag, prices, min_run, decimals = 2) {
    let len = 0;
    let n = 0;
    let wins = 0;
    for (let i = 0; i < flag.length; i++) {
        len = flag[i] ? len + 1 : 0;
        if (len !== min_run) continue; // fires when the run FIRST reaches the level
        const won = settleAt(key, prices, i, decimals);
        if (won === null) continue;
        n += 1;
        if (won) wins += 1;
    }
    return { n, wins, hit: n ? round2((wins / n) * 100) : null };
}

/**
 * @param {number[]} prices oldest first
 * @param {number} decimals the symbol's price precision (for last digits)
 * @param {number} [total_ticks] how many ticks this symbol has ever shown (so a run's id keeps counting as the window slides)
 */
export function computeRunBias(prices, decimals = 2, total_ticks = prices.length) {
    const tail = prices.slice(-RUN_WINDOW);
    const n = tail.length;
    if (n < MIN_RUN_SAMPLE) return { n, min_run: MIN_RUN, rows: [] };
    // This market's own precision, read from its prices (the reported pip size is only a fallback, see inferDecimals).
    const seen_dp = inferDecimals(tail);
    const reported_dp = decimals;
    decimals = seen_dp > 0 && seen_dp <= 8 ? seen_dp : Number.isInteger(decimals) ? decimals : 2;
    const flags = favourFlags(tail, decimals);
    const first_tick_of_window = total_ticks - n; // index (since the symbol started ticking) of tail[0]
    const rows = RUN_CONTRACTS.map(c => {
        const mine = runStats(flags[c.key], MIN_RUN);
        const levels = LEVELS[c.key].map(min_run => {
            const m = runStats(flags[c.key], min_run);
            const t = runStats(flags[c.pair], min_run);
            const both = m.ticks_in_runs + t.ticks_in_runs;
            const out = replayOutcomes(c.key, flags[c.key], tail, min_run, decimals);
            return {
                min_run,
                runs: m.runs,
                ticks_in_runs: m.ticks_in_runs,
                bias: both ? round2((m.ticks_in_runs / both) * 100) : 50,
                outcomes: out.n, // how many times this pattern was replayed (entry tick, exit tick, win or lose)
                wins: out.wins,
                hit: out.hit, // % of those replays that won (null = none yet)
            };
        });
        return {
            key: c.key,
            contract_type: c.contract_type,
            label: c.label,
            runs: levels[0].runs,
            ticks_in_runs: levels[0].ticks_in_runs,
            longest: mine.longest,
            current: mine.current,
            bias: levels[0].bias, // the bias on the shortest level this contract is analysed on
            levels,
            run_start: mine.current ? first_tick_of_window + mine.current_start : null,
            // the last ticks of the run as they print (digit contracts: the last digits; others: the prices), for the trade log
            pattern: mine.current ? tail.slice(-Math.min(mine.current, 3)).map(pr => (['even', 'odd', 'over4', 'under5'].includes(c.key) ? String(lastDigit(pr, decimals)) : Number(pr).toFixed(decimals))) : [],
        };
    });
    return { n, min_run: MIN_RUN, decimals, reported_decimals: reported_dp, trend: detectTrend(tail.slice(-TREND_WINDOW)), rows };
}

/**
 * Signals for the AI. One signal per contract per level whose run is on right now:
 *   entry = the run has reached that level (and is not stale) AND the bias on that level is at least 55%.
 * The run id is per run AND per level, so a run can fire at 2 ticks and again at 3 without ever firing the same level twice.
 */
export function computeRunSignals(scan, symbol) {
    if (!scan || !scan.rows.length) return [];
    const entries = [];
    const extras = [];
    for (const row of scan.rows) {
        const def = RUN_CONTRACTS.find(c => c.key === row.key);
        // Confluence: EVERY analysed run length of this contract (2 AND 3 ticks for Even/Odd and Over 4/Under 5) favours it at once.
        const confluence = row.levels.every(l => l.bias >= 50 + MIN_ENTRY_BIAS_EDGE);
        for (const level of row.levels) {
            if (level.bias <= 50) continue;
            const confidence = Math.round(clamp((level.bias - 50) * 2, 0, 100));
            const fresh = row.current >= level.min_run && row.current <= level.min_run + FRESH_SLACK;
            // Rise / Only Ups need a confirmed higher-high trend, Fall / Only Downs a lower-low trend on the 1-tick chart (checked here, so
            // the AI can buy the very next tick without asking for the chart).
            const need = TREND_NEEDED[row.key];
            const trend_ok = !need || scan.trend === need;
            // After the entry and exit ticks are replayed on this market, a contract that has been LOSING after this pattern is not bought
            // (needs enough replays to mean something; a contract bought as a pair is not judged alone).
            const replayed = level.outcomes >= MIN_OUTCOME_SAMPLE && level.hit !== null;
            const hit_ok = !replayed || !NEEDS_BREAK_EVEN.has(row.key) || level.hit >= BREAK_EVEN_PCT;
            const entry = fresh && trend_ok && hit_ok && level.bias >= 50 + MIN_ENTRY_BIAS_EDGE;
            const signal = {
                family: 'run_bias',
                strategy: 'run_bias',
                contract_type: row.contract_type,
                duration_ticks: def.duration,
                prediction: row.contract_type === 'DIGITOVER' ? 4 : row.contract_type === 'DIGITUNDER' ? 5 : undefined,
                trend: need ? scan.trend : undefined,
                label: row.label,
                confidence,
                entry,
                confluence,
                run_id: entry ? `${row.run_start}:${level.min_run}` : undefined,
                run: { current: row.current, runs: level.runs, ticks_in_runs: level.ticks_in_runs, longest: row.longest, bias: level.bias, min_run: level.min_run, outcomes: level.outcomes, wins: level.wins, hit: level.hit, pattern: row.pattern },
                basis: `Run bias: ${row.label} had ${level.runs} runs of ${level.min_run}+ ticks on ${symbol} over the last ${scan.n} ticks (bias ${level.bias}%, run now ${row.current}). Replayed entry and exit ticks after the same pattern: ${level.wins}/${level.outcomes} won${level.hit === null ? '' : ` (${level.hit}%)`}.`,
            };
            (entry ? entries : extras).push(signal);
        }
    }
    entries.sort((a, b) => b.confidence - a.confidence);
    extras.sort((a, b) => b.confidence - a.confidence);
    return [...entries, ...extras.slice(0, MAX_EXTRA_SIGNALS)];
}
