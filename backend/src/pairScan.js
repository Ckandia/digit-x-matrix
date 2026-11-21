// Two-tick pair scanner. Pure and stateless: reads a rolling window of raw prices for ONE symbol and
// reports, for each of the ten contracts, how often the pattern showed up on two consecutive ticks
// (as a % of all the two-tick windows in the window).
//
// Every window is three prices: entry t0, then two ticks that follow one another, t1 and t2.
//   Even / Odd      the last digit of BOTH t1 and t2 is even / odd
//   Over 4 / Under 5  the last digit of BOTH t1 and t2 is 5-9 / 0-4
//   Rise / Fall     the exit t2 is above / below the entry t0 (a 2-tick Rise/Fall; equal loses both)
//   Only Up / Down  t1 is above t0 AND t2 is above t1 (every tick rises) / every tick falls
//   Touch / No Touch  within the two ticks the price reaches +0.5 above the entry / never does
//
// For every contract the report also carries the frequency chance alone would give (the same market's own
// single-tick rates, assuming ticks do not influence each other) and a z-score of the gap. A pattern that
// shows up more often than that is a candidate; the frontend's virtual hook paper-tests it before any live
// trade. This is a statistical description of the last few hundred ticks, NOT a validated edge: Deriv's
// synthetic indices are built as random processes, and the paper/live results are the real test.

export const PAIR_TOUCH_BARRIER = 0.5;
export const MIN_PAIR_SAMPLE = 100; // windows needed before anything is reported as a signal
const BASELINE_RETURNS = 120; // recent tick moves used for the chance baseline of the price-based contracts
const MIN_PAIR_CONFIDENCE = 30; // z >= 1.5: ten patterns x several markets are compared, so weaker gaps are mostly noise
const MAX_PAIR_SIGNALS = 3; // per symbol, so the ranking is not flooded

export const PAIR_CONTRACTS = [
    { key: 'even', contract_type: 'DIGITEVEN', label: 'Even', family_group: 'digit' },
    { key: 'odd', contract_type: 'DIGITODD', label: 'Odd', family_group: 'digit' },
    { key: 'over4', contract_type: 'DIGITOVER', label: 'Over 4', family_group: 'digit' },
    { key: 'under5', contract_type: 'DIGITUNDER', label: 'Under 5', family_group: 'digit' },
    { key: 'rise', contract_type: 'CALL', label: 'Rise', family_group: 'price' },
    { key: 'fall', contract_type: 'PUT', label: 'Fall', family_group: 'price' },
    { key: 'only_up', contract_type: 'RUNHIGH', label: 'Only Up', family_group: 'price' },
    { key: 'only_down', contract_type: 'RUNLOW', label: 'Only Down', family_group: 'price' },
    { key: 'touch', contract_type: 'ONETOUCH', label: 'Touch', family_group: 'price' },
    { key: 'no_touch', contract_type: 'NOTOUCH', label: 'No Touch', family_group: 'price' },
];

const DURATION = { DIGITEVEN: 1, DIGITODD: 1, DIGITOVER: 1, DIGITUNDER: 1, CALL: 1, PUT: 1, RUNHIGH: 2, RUNLOW: 2, ONETOUCH: 5, NOTOUCH: 5 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = n => Math.round(n * 100) / 100;

export const lastDigit = (price, decimals = 2) => {
    const fixed = Number(price).toFixed(Number.isInteger(decimals) ? decimals : 2);
    return Number(fixed[fixed.length - 1]);
};

/** Does the three-price window [t0, t1, t2] show the pattern? */
const matches = (key, t0, t1, t2, decimals, barrier) => {
    switch (key) {
        case 'even':
        case 'odd':
        case 'over4':
        case 'under5': {
            const a = lastDigit(t1, decimals);
            const b = lastDigit(t2, decimals);
            if (key === 'even') return a % 2 === 0 && b % 2 === 0;
            if (key === 'odd') return a % 2 === 1 && b % 2 === 1;
            if (key === 'over4') return a > 4 && b > 4;
            return a < 5 && b < 5;
        }
        case 'rise':
            return t2 > t0;
        case 'fall':
            return t2 < t0;
        case 'only_up':
            return t1 > t0 && t2 > t1;
        case 'only_down':
            return t1 < t0 && t2 < t1;
        case 'touch':
            return t1 - t0 >= barrier || t2 - t0 >= barrier;
        case 'no_touch':
            return !(t1 - t0 >= barrier || t2 - t0 >= barrier);
        default:
            return false;
    }
};

/**
 * What chance alone would give: the digit patterns use the window's own single-digit rates squared; the price patterns
 * pair up the recent tick moves at random (every a followed by every b) and count how often that pairing shows the pattern.
 */
const expectedPct = (key, prices, decimals, barrier) => {
    const digits = prices.map(p => lastDigit(p, decimals));
    const share = test => digits.filter(test).length / Math.max(1, digits.length);
    switch (key) {
        case 'even':
            return share(d => d % 2 === 0) ** 2;
        case 'odd':
            return share(d => d % 2 === 1) ** 2;
        case 'over4':
            return share(d => d > 4) ** 2;
        case 'under5':
            return share(d => d < 5) ** 2;
        default:
            break;
    }
    const moves = [];
    for (let i = 1; i < prices.length; i++) moves.push(prices[i] - prices[i - 1]);
    const recent = moves.slice(-BASELINE_RETURNS);
    if (!recent.length) return 0;
    let hits = 0;
    let total = 0;
    for (const a of recent) {
        for (const b of recent) {
            total += 1;
            if (matches(key, 0, a, a + b, decimals, barrier)) hits += 1;
        }
    }
    return hits / total;
};

/**
 * @param {number[]} prices oldest first
 * @param {number} decimals the symbol's price precision (for last digits)
 * @returns {{ n: number, barrier: number, rows: object[] }}
 */
export function computePairFrequencies(prices, decimals = 2, barrier = PAIR_TOUCH_BARRIER) {
    const n = Math.max(0, prices.length - 2);
    const hits = Object.fromEntries(PAIR_CONTRACTS.map(c => [c.key, 0]));
    for (let i = 2; i < prices.length; i++) {
        const t0 = prices[i - 2];
        const t1 = prices[i - 1];
        const t2 = prices[i];
        for (const c of PAIR_CONTRACTS) if (matches(c.key, t0, t1, t2, decimals, barrier)) hits[c.key] += 1;
    }
    const rows = PAIR_CONTRACTS.map(c => {
        const pct = n ? (hits[c.key] / n) * 100 : 0;
        let expected = null;
        let z = null;
        if (n >= MIN_PAIR_SAMPLE) {
            const e = expectedPct(c.key, prices, decimals, barrier);
            expected = round2(e * 100);
            const se = Math.sqrt((e * (1 - e)) / n);
            z = se > 0 ? round2((hits[c.key] / n - e) / se) : 0;
        }
        return { key: c.key, contract_type: c.contract_type, label: c.label, hits: hits[c.key], pct: round2(pct), expected_pct: expected, z };
    });
    return { n, barrier, rows };
}

/** The patterns that show up more often than chance, as signals the auto-pilot can paper-test and then trade. */
export function computePairSignals(scan, symbol) {
    if (!scan || scan.n < MIN_PAIR_SAMPLE) return [];
    const signals = [];
    for (const row of scan.rows) {
        if (row.z === null || row.z <= 0) continue;
        const confidence = Math.round(clamp(row.z * 20, 0, 100));
        if (confidence < MIN_PAIR_CONFIDENCE) continue;
        signals.push({
            family: 'pairs',
            contract_type: row.contract_type,
            duration_ticks: DURATION[row.contract_type],
            prediction: row.contract_type === 'DIGITOVER' ? 4 : row.contract_type === 'DIGITUNDER' ? 5 : row.contract_type === 'ONETOUCH' || row.contract_type === 'NOTOUCH' ? `+${scan.barrier}` : undefined,
            label: row.label,
            confidence,
            basis: `Two-tick pattern: ${row.label} showed up on ${row.pct}% of the last ${scan.n} two-tick windows on ${symbol} (chance alone: ${row.expected_pct}%).`,
        });
    }
    return signals.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_PAIR_SIGNALS);
}
