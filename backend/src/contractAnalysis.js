// Pure, stateless statistics helpers over a rolling window of raw prices for one symbol:
// the counterpart to digitAnalysis.js for the contracts that depend on price movement.
//
// ONE-TICK ANALYSIS. The auto-pilot buys every contract for 1 tick (barrier contracts excepted),
// so the question asked here is "what does the NEXT tick do?", not "where is the drift over the
// last N ticks?". Families kept:
//   - Rise/Fall (CALL/PUT): next-tick direction from the tick-to-tick transition table.
//   - Touch/No Touch, Stays Between/Goes Outside and Ends Between/Outside: barrier contracts, the
//     only ones that run longer. Which side is offered follows the owner's notes: a quiet market
//     favours No Touch / Stays Between / Ends Between, an expanding one favours Touch / Goes Outside /
//     Ends Outside.
// Dropped because Deriv does not sell them at 1 tick (it rejects the buy): Asians (min 5 ticks),
// Only Ups/Downs (min 2), High/Low Tick (fixed 5), Reset Call/Put (min 5).
//
// Every signal is a statistical deviation score, NOT a validated edge or a win probability.
// Deriv's synthetic indices are designed as fair random processes; the numbers describe what the
// last few hundred ticks did, and the learner (frontend) is what checks whether acting on them
// actually paid. Barrier distances are the part most likely to need adjusting against Deriv's
// live validation; the engine now asks Deriv for a price first, so a bad barrier is skipped
// instead of bought.

export const PRICE_WINDOW_SIZE = 500; // matches the digit window, so the two-tick pair scan sees the same ticks
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

const TOUCH_TICKS = 5; // shortest duration Deriv offers for Touch/No Touch and Ends Between/Outside
const MIN_TRANSITIONS = 40; // minimum observations behind the "what follows an up/down tick" row

/**
 * For every tick that followed an up tick (and every tick that followed a down tick): did the next
 * tick go up, down, or stay flat? A flat tick matters: it loses BOTH Rise and Fall.
 */
const transitionTable = prices => {
    const row = () => ({ n: 0, up: 0, down: 0, flat: 0 });
    const table = { up: row(), down: row() };
    for (let i = 2; i < prices.length; i++) {
        const prev = Math.sign(prices[i - 1] - prices[i - 2]);
        if (prev === 0) continue;
        const next = Math.sign(prices[i] - prices[i - 1]);
        const r = prev > 0 ? table.up : table.down;
        r.n += 1;
        if (next > 0) r.up += 1;
        else if (next < 0) r.down += 1;
        else r.flat += 1;
    }
    return table;
};

/**
 * Turns a price window into a ranked list of candidate signals. Returns [] until
 * MIN_SAMPLE_FOR_CONTRACT_SIGNAL prices have been collected.
 */
export function computeContractSignals(window, symbol, decimals = 2) {
    const { prices } = window;
    if (prices.length < MIN_SAMPLE_FOR_CONTRACT_SIGNAL) return [];

    const rets = returns(prices.slice(-100));
    const signals = [];

    // --- Rise/Fall (CALL/PUT), 1 tick: which way did the tick AFTER a tick like the last one go? ---
    const last_move = Math.sign(prices[prices.length - 1] - prices[prices.length - 2]);
    if (last_move !== 0) {
        const table = transitionTable(prices);
        const row = last_move > 0 ? table.up : table.down;
        if (row.n >= MIN_TRANSITIONS) {
            const p_up = row.up / row.n;
            const p_down = row.down / row.n;
            const flat_rate = row.flat / row.n;
            const rising = p_up >= p_down;
            const p_side = rising ? p_up : p_down;
            // Fair chance for either side once flat ticks (which lose both) are taken out.
            const fair = (1 - flat_rate) / 2;
            const z = (p_side - fair) / Math.sqrt((fair * (1 - fair)) / row.n);
            const conf = Math.round(clamp(z * 20, 0, 100));
            if (conf >= 15) {
                signals.push({
                    family: 'rise_fall',
                    contract_type: rising ? 'CALL' : 'PUT',
                    duration_ticks: 1,
                    label: rising ? 'Rise' : 'Fall',
                    confidence: conf,
                    basis: `After ${last_move > 0 ? 'an up' : 'a down'} tick, the next tick went ${rising ? 'up' : 'down'} ${Math.round(p_side * 100)}% of the time (n=${row.n}, ${Math.round(flat_rate * 100)}% flat, fair ${Math.round(fair * 100)}%) on ${symbol}.`,
                });
            }
        }
    }

    // --- Touch/No Touch and Ends Between/Ends Outside — barrier contracts, volatility regime ---
    // Which side gets the signal depends on whether volatility is currently expanding (favours
    // Touch / Ends Outside) or contracting (favours No Touch / Ends Between) against its own
    // longer-run average. These run TOUCH_TICKS ticks, so the barrier scales with sqrt(TOUCH_TICKS).
    const baseline_sigma_raw = stddev(rets);
    // A genuinely flat/stale feed (baseline volatility ~0) has nothing meaningful to say.
    if (rets.length >= 40 && baseline_sigma_raw > prices[prices.length - 1] * 1e-6) {
        const recent_sigma = stddev(rets.slice(-15));
        const baseline_sigma = baseline_sigma_raw;
        const vol_ratio = recent_sigma / baseline_sigma;
        const vol_conf = Math.round(clamp(Math.abs(vol_ratio - 1) * 140, 0, 100));
        // Deriv rejects barriers with more decimal places than the symbol's own price precision, so
        // round to exactly that many (and never below 3 pips, since a barrier at ~spot is invalid).
        const pip = 10 ** -decimals;
        const raw_offset = Math.max(1.5 * baseline_sigma * Math.sqrt(TOUCH_TICKS), 3 * pip);
        const barrier_offset = raw_offset.toFixed(decimals); // string, e.g. "0.35"

        if (vol_conf >= 15) {
            const expanding = vol_ratio > 1;
            signals.push({
                family: 'touch',
                contract_type: expanding ? 'ONETOUCH' : 'NOTOUCH',
                duration_ticks: TOUCH_TICKS,
                prediction: `+${barrier_offset}`,
                label: expanding ? 'Touch' : 'No touch',
                confidence: vol_conf,
                basis: `Realized volatility is ${expanding ? 'expanding' : 'contracting'} (recent/baseline ratio ${round2(vol_ratio)}).`,
            });
            signals.push({
                family: 'ends',
                contract_type: expanding ? 'EXPIRYMISS' : 'EXPIRYRANGE',
                duration_ticks: TOUCH_TICKS,
                prediction: barrier_offset, // unsigned offset string; the frontend builds +/- barriers from it
                label: expanding ? 'Ends outside' : 'Ends between',
                confidence: Math.round(vol_conf * 0.95),
                basis: `Same volatility read, applied to a symmetric range \u00b1${barrier_offset} around spot.`,
            });
            // Stays Between / Goes Outside watch EVERY tick (Ends Between/Outside only the last one).
            signals.push({
                family: 'range',
                contract_type: expanding ? 'UPORDOWN' : 'RANGE',
                duration_ticks: TOUCH_TICKS,
                prediction: barrier_offset,
                label: expanding ? 'Goes outside' : 'Stays between',
                confidence: Math.round(vol_conf * 0.95),
                basis: `Volatility is ${expanding ? 'expanding' : 'contracting'} (recent/baseline ${round2(vol_ratio)}), the state where ${expanding ? 'Goes Outside' : 'Stays Between'} is easiest per your notes; range \u00b1${barrier_offset}.`,
            });
        }
    }

    return signals.sort((a, b) => b.confidence - a.confidence);
}
