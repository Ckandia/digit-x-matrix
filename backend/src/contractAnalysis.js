// Pure, stateless statistics helpers over a rolling window of raw prices for one
// symbol — the counterpart to digitAnalysis.js, but for the contract families
// that depend on price movement rather than last-digit frequency: Rise/Fall,
// Only Ups/Only Downs, Touch/No Touch, Ends Between/Ends Outside, Asians,
// High Tick/Low Tick, and Reset Call/Reset Put.
//
// Every signal here is, like digitAnalysis.js's, a *statistical deviation or
// momentum score* — not a validated trading edge or a win-probability
// estimate. Deriv's synthetic indices are designed as fair random-walk
// processes; a strong recent drift or streak is a real, measurable thing
// about the last N ticks, but it does not change the odds of the next one.
// Two families here (Touch/No Touch, Ends Between/Ends Outside) also need a
// barrier price, computed from recent volatility — this is the part most
// likely to need adjustment once tested against Deriv's live barrier
// validation, since the exact accepted format can be pickier than the
// general shape used here.

export const PRICE_WINDOW_SIZE = 300;
export const MIN_SAMPLE_FOR_CONTRACT_SIGNAL = 60;

export function createPriceWindow() {
    return { prices: [], last_updated: null };
}

export function pushPrice(window, price) {
    const value = Number(price);
    if (!Number.isFinite(value)) return window;
    window.prices.push(value);
    if (window.prices.length > PRICE_WINDOW_SIZE) window.prices.shift();
    window.last_updated = new Date().toISOString();
    return window;
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round2 = n => Math.round(n * 100) / 100;

const returns = prices => {
    const out = [];
    for (let i = 1; i < prices.length; i++) out.push(prices[i] - prices[i - 1]);
    return out;
};

const stddev = arr => {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
};

/** Net drift over the last `n` ticks, in units of the recent return stddev. */
const driftZScore = (prices, n, sigma) => {
    if (prices.length < n + 1 || sigma <= 0) return 0;
    const drift = prices[prices.length - 1] - prices[prices.length - 1 - n];
    return drift / (sigma * Math.sqrt(n));
};

/** Trailing run of consecutive same-direction ticks (up or down), and its sign. */
const trailingRun = prices => {
    if (prices.length < 2) return { length: 0, direction: 0 };
    let length = 0;
    let direction = 0;
    for (let i = prices.length - 1; i > 0; i--) {
        const d = Math.sign(prices[i] - prices[i - 1]);
        if (d === 0) break;
        if (direction === 0) direction = d;
        if (d !== direction) break;
        length += 1;
    }
    return { length, direction };
};

const DURATION_CANDIDATES = [1, 2, 3, 5, 10];

/** Picks whichever lookback (from DURATION_CANDIDATES) has the strongest drift
 *  z-score, on the assumption that a lookback where momentum was most
 *  pronounced is the most informative window size to also use forward. */
const bestMomentumWindow = (prices, sigma) => {
    let best = { n: DURATION_CANDIDATES[0], z: 0 };
    for (const n of DURATION_CANDIDATES) {
        const z = driftZScore(prices, n, sigma);
        if (Math.abs(z) > Math.abs(best.z)) best = { n, z };
    }
    return best;
};

/**
 * Turns a price window into a ranked list of candidate signals across the 8
 * non-digit families the auto-pilot trades. Returns [] until
 * MIN_SAMPLE_FOR_CONTRACT_SIGNAL prices have been collected.
 */
export function computeContractSignals(window, symbol) {
    const { prices } = window;
    if (prices.length < MIN_SAMPLE_FOR_CONTRACT_SIGNAL) return [];

    const rets = returns(prices.slice(-100));
    const sigma = stddev(rets) || prices[prices.length - 1] * 0.0001; // avoid div-by-zero on a flat window
    const signals = [];

    // --- Rise/Fall (CALL/PUT) — direction of the strongest recent drift ---
    const momentum = bestMomentumWindow(prices, sigma);
    const momentum_conf = Math.round(clamp(Math.abs(momentum.z) * 18, 0, 100));
    if (momentum_conf >= 15) {
        const rising = momentum.z > 0;
        signals.push({
            family: 'rise_fall',
            contract_type: rising ? 'CALL' : 'PUT',
            duration_ticks: momentum.n,
            label: rising ? 'Rise' : 'Fall',
            confidence: momentum_conf,
            basis: `Net drift over the last ${momentum.n} ticks is ${round2(Math.abs(momentum.z))}\u03c3 ${rising ? 'up' : 'down'} on ${symbol}.`,
        });

        // --- Reset Call/Reset Put — same directional read, different contract ---
        signals.push({
            family: 'reset',
            contract_type: rising ? 'RESETCALL' : 'RESETPUT',
            duration_ticks: momentum.n,
            label: rising ? 'Reset call' : 'Reset put',
            confidence: Math.round(momentum_conf * 0.9), // barrier reset gives some cushion — slightly lower stated confidence
            basis: `Same ${round2(Math.abs(momentum.z))}\u03c3 drift as Rise/Fall, with a mid-contract barrier reset.`,
        });

        // --- Asian Up/Down — payout follows the average vs entry, same directional bias ---
        signals.push({
            family: 'asians',
            contract_type: rising ? 'ASIANU' : 'ASIAND',
            duration_ticks: clamp(momentum.n, 5, 10),
            label: rising ? 'Asian up' : 'Asian down',
            confidence: Math.round(momentum_conf * 0.85),
            basis: `Recent drift suggests the tick average is more likely to land ${rising ? 'above' : 'below'} entry.`,
        });
    }

    // --- Only Ups/Only Downs (RUNHIGH/RUNLOW) — trailing consecutive-tick run ---
    const run = trailingRun(prices.slice(-40));
    if (run.length >= 2) {
        // Frequency of runs of this length actually continuing one more tick,
        // measured in this window, vs the 0.5^n fair-coin baseline.
        let continued = 0;
        let occurrences = 0;
        for (let i = run.length; i < prices.length - 1; i++) {
            let matches = true;
            for (let k = 0; k < run.length; k++) {
                if (Math.sign(prices[i - k] - prices[i - k - 1]) !== run.direction) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                occurrences += 1;
                if (Math.sign(prices[i + 1] - prices[i]) === run.direction) continued += 1;
            }
        }
        // Require a real sample before trusting this rate at all — with only a
        // handful of occurrences, "continued 5/6 times" is noise, not signal.
        // MIN_OCCURRENCES_FOR_RUN_SIGNAL below is deliberately high because a
        // continuation *rate* is a much higher-variance statistic than a
        // simple frequency count (digitAnalysis.js's deviationConfidence
        // equivalent): each occurrence is only a single win/lose data point.
        const MIN_OCCURRENCES_FOR_RUN_SIGNAL = 25;
        const observed_rate = occurrences > 0 ? continued / occurrences : 0.5;
        const baseline_rate = 0.5;
        const sample_factor = clamp(occurrences / MIN_OCCURRENCES_FOR_RUN_SIGNAL, 0, 1.5);
        const run_conf = Math.round(clamp(Math.abs(observed_rate - baseline_rate) * 300 * sample_factor, 0, 100));
        if (occurrences >= MIN_OCCURRENCES_FOR_RUN_SIGNAL && run_conf >= 15) {
            signals.push({
                family: 'only_up_down',
                contract_type: run.direction > 0 ? 'RUNHIGH' : 'RUNLOW',
                duration_ticks: clamp(run.length, 2, 5),
                label: run.direction > 0 ? 'Only ups' : 'Only downs',
                confidence: run_conf,
                basis: `A ${run.length}-tick ${run.direction > 0 ? 'up' : 'down'} run has continued ${Math.round(observed_rate * 100)}% of the time recently (n=${occurrences}) vs a 50% fair baseline.`,
            });
        }
    }

    // --- Touch/No Touch and Ends Between/Ends Outside — volatility regime ---
    // Barrier offset scales with recent realized volatility; which side gets
    // the signal depends on whether volatility is currently expanding
    // (favours Touch / Ends Outside) or contracting (favours No Touch / Ends
    // Between) relative to its own longer-run average.
    const baseline_sigma_raw = stddev(rets);
    // A genuinely flat/stale feed (baseline volatility ~0) has nothing
    // meaningful to say about volatility expanding or contracting — skip
    // rather than let a near-zero denominator produce a false maximal ratio.
    if (rets.length >= 40 && baseline_sigma_raw > prices[prices.length - 1] * 1e-6) {
        const recent_sigma = stddev(rets.slice(-15));
        const baseline_sigma = baseline_sigma_raw;
        const vol_ratio = recent_sigma / baseline_sigma;
        const vol_conf = Math.round(clamp(Math.abs(vol_ratio - 1) * 140, 0, 100));
        const barrier_offset = round2(1.5 * baseline_sigma * 100) / 100; // absolute price units

        if (vol_conf >= 15) {
            const expanding = vol_ratio > 1;
            signals.push({
                family: 'touch',
                contract_type: expanding ? 'ONETOUCH' : 'NOTOUCH',
                duration_ticks: 10,
                prediction: expanding ? `+${barrier_offset}` : `+${barrier_offset}`, // offset magnitude; direction (touch either side) is symbol-agnostic
                label: expanding ? 'Touch' : 'No touch',
                confidence: vol_conf,
                basis: `Realized volatility is ${expanding ? 'expanding' : 'contracting'} (recent/baseline ratio ${round2(vol_ratio)}).`,
            });
            signals.push({
                family: 'ends',
                contract_type: expanding ? 'EXPIRYMISS' : 'EXPIRYRANGE',
                duration_ticks: 10,
                prediction: barrier_offset,
                label: expanding ? 'Ends outside' : 'Ends between',
                confidence: Math.round(vol_conf * 0.95),
                basis: `Same volatility read, applied to a symmetric range \u00b1${barrier_offset} around spot.`,
            });
        }
    }

    // --- High Tick/Low Tick — which of the next 5 ticks is likely the extreme ---
    // Deriv fixes this contract's duration at 5 ticks with a selected_tick 1-5.
    // Strong momentum makes the *last* tick the plausible new high (uptrend)
    // or low (downtrend); this is the weakest-evidence family here since it's
    // a single-tick pick rather than a distributional read.
    if (Math.abs(momentum.z) >= 1.2) {
        const rising = momentum.z > 0;
        signals.push({
            family: 'high_low_tick',
            contract_type: rising ? 'TICKHIGH' : 'TICKLOW',
            duration_ticks: 5,
            prediction: 5, // selected_tick — the 5th (final) tick of the contract
            label: rising ? 'High tick' : 'Low tick',
            confidence: Math.round(clamp((Math.abs(momentum.z) - 1) * 25, 0, 100)),
            basis: `Strong ${round2(Math.abs(momentum.z))}\u03c3 momentum makes the final tick the plausible extreme.`,
        });
    }

    return signals.sort((a, b) => b.confidence - a.confidence);
}
