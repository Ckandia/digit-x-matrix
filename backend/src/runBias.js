// Run bias. Pure and stateless: reads a rolling window of raw prices for ONE symbol and reports, for each contract,
// how often 3 OR MORE ticks IN A ROW favoured it (a "run"), and whether such a run is happening right now.
//
// What counts as a tick in favour of a contract:
//   Even / Odd        the last digit is even / odd          (even 2,4,6   odd 1,3,7)
//   Over 4 / Under 5  the last digit is 5-9 / 0-4           (over 4: 5,8,9   under 5: 2,1,4)
//   Rise / Fall       the price moved up / down from the tick before
//   Only Up / Down    the same as Rise / Fall: a run of rising (falling) ticks is exactly what Only Ups (Only Downs) needs
//   Touch             an up move at least as big as the market's typical tick move (it is reaching for the +0.5 barrier)
//   No Touch          a quiet tick: a move smaller than the market's typical tick move (or any down move)
//
// Per contract the report carries: runs (how many separate runs of >= 3 appeared in the window), ticks_in_runs (how many ticks sat
// inside them), longest run, the CURRENT run length, and a bias in percent: that contract's share of all run ticks of the pair
// (Even vs Odd, Over 4 vs Under 5, Rise vs Fall, ...). 50 = balanced; the higher the number, the more the market is favouring it.
// An ENTRY signal is raised when the current run is >= 3 ticks AND the bias is above 50 by at least MIN_ENTRY_BIAS_EDGE.
//
// This is a description of the last few hundred ticks. Deriv's synthetic indices are random processes: a bias reading is not a
// validated edge, and every contract still pays less than 2x. The numbers are here so the AI has a consistent, fast signal.

export const MIN_RUN = 3;
export const RUN_WINDOW = 300; // ticks the bias is measured on (the freshest, so it follows the market)
export const MIN_RUN_SAMPLE = 60; // ticks needed before anything is reported
export const MIN_ENTRY_BIAS_EDGE = 5; // bias must be at least 55 for an entry signal
const MAX_RUN_SIGNALS = 4; // per symbol, strongest first

export const RUN_CONTRACTS = [
    { key: 'even', contract_type: 'DIGITEVEN', label: 'Even', pair: 'odd', duration: 1 },
    { key: 'odd', contract_type: 'DIGITODD', label: 'Odd', pair: 'even', duration: 1 },
    { key: 'over4', contract_type: 'DIGITOVER', label: 'Over 4', pair: 'under5', duration: 1 },
    { key: 'under5', contract_type: 'DIGITUNDER', label: 'Under 5', pair: 'over4', duration: 1 },
    { key: 'rise', contract_type: 'CALL', label: 'Rise', pair: 'fall', duration: 1 },
    { key: 'fall', contract_type: 'PUT', label: 'Fall', pair: 'rise', duration: 1 },
    { key: 'only_up', contract_type: 'RUNHIGH', label: 'Only Ups', pair: 'only_down', duration: 2 },
    { key: 'only_down', contract_type: 'RUNLOW', label: 'Only Downs', pair: 'only_up', duration: 2 },
    { key: 'touch', contract_type: 'ONETOUCH', label: 'Touch', pair: 'no_touch', duration: 5 },
    { key: 'no_touch', contract_type: 'NOTOUCH', label: 'No Touch', pair: 'touch', duration: 5 },
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
    const moves = [];
    for (let i = 1; i < n; i++) moves.push(Math.abs(prices[i] - prices[i - 1]));
    const sorted = [...moves].sort((a, b) => a - b);
    const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; // median tick move
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
        flags.touch[i] = move > 0 && move >= typical;
        flags.no_touch[i] = move <= 0 || Math.abs(move) < typical;
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
    const stats = Object.fromEntries(RUN_CONTRACTS.map(c => [c.key, runStats(flags[c.key])]));
    const rows = RUN_CONTRACTS.map(c => {
        const mine = stats[c.key];
        const theirs = stats[c.pair];
        const both = mine.ticks_in_runs + theirs.ticks_in_runs;
        const bias = both ? round2((mine.ticks_in_runs / both) * 100) : 50;
        const first_tick_of_window = total_ticks - n; // index (since the symbol started ticking) of tail[0]
        return {
            key: c.key,
            contract_type: c.contract_type,
            label: c.label,
            runs: mine.runs,
            ticks_in_runs: mine.ticks_in_runs,
            longest: mine.longest,
            current: mine.current,
            bias,
            run_id: mine.current ? first_tick_of_window + mine.current_start : null,
        };
    });
    return { n, min_run: MIN_RUN, rows };
}

/** Signals for the AI: every contract whose bias is above 50 (strongest first); `entry` is true when its 3+ tick run is happening now. */
export function computeRunSignals(scan, symbol) {
    if (!scan || !scan.rows.length) return [];
    const signals = [];
    for (const row of scan.rows) {
        if (row.bias <= 50) continue;
        const def = RUN_CONTRACTS.find(c => c.key === row.key);
        const confidence = Math.round(clamp((row.bias - 50) * 2, 0, 100));
        const entry = row.current >= MIN_RUN && row.bias >= 50 + MIN_ENTRY_BIAS_EDGE;
        signals.push({
            family: 'run_bias',
            strategy: 'run_bias',
            contract_type: row.contract_type,
            duration_ticks: def.duration,
            prediction: row.contract_type === 'DIGITOVER' ? 4 : row.contract_type === 'DIGITUNDER' ? 5 : row.contract_type === 'ONETOUCH' || row.contract_type === 'NOTOUCH' ? '+0.5' : undefined,
            label: row.label,
            confidence,
            entry,
            run_id: entry ? row.run_id : undefined,
            run: { current: row.current, runs: row.runs, ticks_in_runs: row.ticks_in_runs, longest: row.longest, bias: row.bias },
            basis: `Run bias: ${row.label} had ${row.runs} runs of ${MIN_RUN}+ ticks on ${symbol} over the last ${scan.n} ticks (bias ${row.bias}%, run now ${row.current}).`,
        });
    }
    // Entry signals first (strongest bias first), then the rest, capped so the ranking is not flooded.
    signals.sort((a, b) => Number(b.entry) - Number(a.entry) || b.confidence - a.confidence);
    return signals.slice(0, MAX_RUN_SIGNALS * 2).filter((s, i) => s.entry || i < MAX_RUN_SIGNALS);
}
