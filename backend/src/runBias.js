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
 * @param {number[]} prices oldest first
 * @param {number} decimals the symbol's price precision (for last digits)
 * @param {number} [total_ticks] how many ticks this symbol has ever shown (so a run's id keeps counting as the window slides)
 */
export function computeRunBias(prices, decimals = 2, total_ticks = prices.length) {
    const tail = prices.slice(-RUN_WINDOW);
    const n = tail.length;
    if (n < MIN_RUN_SAMPLE) return { n, min_run: MIN_RUN, rows: [] };
    const flags = favourFlags(tail, decimals);
    const first_tick_of_window = total_ticks - n; // index (since the symbol started ticking) of tail[0]
    const rows = RUN_CONTRACTS.map(c => {
        const mine = runStats(flags[c.key], MIN_RUN);
        const levels = LEVELS[c.key].map(min_run => {
            const m = runStats(flags[c.key], min_run);
            const t = runStats(flags[c.pair], min_run);
            const both = m.ticks_in_runs + t.ticks_in_runs;
            return {
                min_run,
                runs: m.runs,
                ticks_in_runs: m.ticks_in_runs,
                bias: both ? round2((m.ticks_in_runs / both) * 100) : 50,
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
        };
    });
    return { n, min_run: MIN_RUN, trend: detectTrend(tail.slice(-TREND_WINDOW)), rows };
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
            const entry = fresh && trend_ok && level.bias >= 50 + MIN_ENTRY_BIAS_EDGE;
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
                run: { current: row.current, runs: level.runs, ticks_in_runs: level.ticks_in_runs, longest: row.longest, bias: level.bias, min_run: level.min_run },
                basis: `Run bias: ${row.label} had ${level.runs} runs of ${level.min_run}+ ticks on ${symbol} over the last ${scan.n} ticks (bias ${level.bias}%, run now ${row.current}).`,
            };
            (entry ? entries : extras).push(signal);
        }
    }
    entries.sort((a, b) => b.confidence - a.confidence);
    extras.sort((a, b) => b.confidence - a.confidence);
    return [...entries, ...extras.slice(0, MAX_EXTRA_SIGNALS)];
}
