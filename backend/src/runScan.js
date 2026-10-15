// Run scanner (market bias). Pure and stateless: reads a rolling window of raw prices for ONE symbol and reports, for each
// ticked contract, how often a RUN of three or more consecutive ticks in that contract's favour appeared.
//
//   Even    every tick's last digit is even   (e.g. 2, 4, 6)
//   Odd     every tick's last digit is odd    (e.g. 1, 3, 7)
//   Over 4  every tick's last digit is 5-9    (e.g. 5, 8, 9)
//   Under 5 every tick's last digit is 0-4    (e.g. 2, 1, 4)
//   Rise    every tick closes above the one before (also what Only Up needs)
//   Fall    every tick closes below the one before (also what Only Down needs)
//
// The measure, like the two-tick pair scan but for three ticks: every window of three consecutive ticks in which ALL three favour
// the contract counts (a run of 6 holds four such windows, so the longer the runs, the higher the count). Reported per contract:
//   pct          % of the three-tick windows in which all three ticks favoured it
//   expected_pct what a FAIR market gives (every tick has a 50% chance, so 12.5%); z is the gap in standard errors, computed with
//                the exact variance of overlapping windows. The higher the z, the more this market has favoured the contract:
//                that is the "market bias" (bias = z * 20, 0-100).
//   cluster_z    the same gap against this market's OWN single-tick rate: is it clustering more than its rate explains?
//   runs/per100  how many separate runs of 3+ appeared (a run of 6 is one run), the longest run, and the run in progress right
//                now (a run of two means the next favouring tick makes three: that is what the entry reader looks for).
//
// What this is NOT: a validated edge. Deriv's synthetic indices are built as random processes, so a bias in the last few
// hundred ticks says what the stream has done, not what the next tick will do. The frontend uses it only to choose WHICH
// market and contract to read for an entry (a tie-break), and the paper/live results are the real test.
// Touch / No Touch have no per-tick rule (they depend on distance travelled), so they are not scanned here; see pairScan.js.

export const RUN_MIN = 3; // the shortest run that counts
export const MIN_RUN_SAMPLE = 100; // ticks needed before a z-score is reported
export const RECENT_TICKS = 100; // the "right now" window
export const FAVOURED_Z = 1.5; // worth a look. About 1 cell in 12 reaches this by chance alone, and six contracts on ten markets are compared.

export const RUN_CONTRACTS = [
    { key: 'even', label: 'Even', contract_types: ['DIGITEVEN'] },
    { key: 'odd', label: 'Odd', contract_types: ['DIGITODD'] },
    { key: 'over4', label: 'Over 4', contract_types: ['DIGITOVER'] },
    { key: 'under5', label: 'Under 5', contract_types: ['DIGITUNDER'] },
    { key: 'rise', label: 'Rise / Only Up', contract_types: ['CALL', 'RUNHIGH'] },
    { key: 'fall', label: 'Fall / Only Down', contract_types: ['PUT', 'RUNLOW'] },
];

const round2 = n => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const lastDigit = (price, decimals = 2) => {
    const fixed = Number(price).toFixed(Number.isInteger(decimals) ? decimals : 2);
    return Number(fixed[fixed.length - 1]);
};

/** Does the tick at `price` (previous tick `prev`) favour the contract? */
const favours = (key, price, prev, decimals) => {
    switch (key) {
        case 'even':
            return lastDigit(price, decimals) % 2 === 0;
        case 'odd':
            return lastDigit(price, decimals) % 2 === 1;
        case 'over4':
            return lastDigit(price, decimals) > 4;
        case 'under5':
            return lastDigit(price, decimals) < 5;
        case 'rise':
            return price > prev;
        case 'fall':
            return price < prev;
        default:
            return false;
    }
};

/**
 * Runs of true in `flags`: `triples` = windows of k consecutive trues (a run of 6 holds four of them), `runs` = separate runs of
 * k or more, how many reach 4 and 5, the longest run, and `current`, the run in progress at the newest tick.
 */
export const scanFlags = (flags, k = RUN_MIN) => {
    let triples = 0;
    let runs = 0;
    let runs4 = 0;
    let runs5 = 0;
    let longest = 0;
    let len = 0;
    const close = () => {
        if (len >= k) {
            runs += 1;
            if (len >= 4) runs4 += 1;
            if (len >= 5) runs5 += 1;
        }
        longest = Math.max(longest, len);
    };
    for (const f of flags) {
        if (f) {
            len += 1;
            if (len >= k) triples += 1;
        } else {
            close();
            len = 0;
        }
    }
    const current = len;
    close();
    return { triples, runs, runs4, runs5, longest, current };
};

/** Mean and variance of the number of k-windows that are all true, over `windows` overlapping windows of independent trials. */
export const windowMoments = (windows, p, k = RUN_MIN) => {
    if (windows <= 0) return { mean: 0, variance: 0 };
    const q = p ** k;
    let variance = windows * q * (1 - q);
    // overlapping windows (up to k-1 apart) share ticks, so they move together
    for (let d = 1; d < k; d++) variance += 2 * Math.max(0, windows - d) * (p ** (k + d) - q * q);
    return { mean: windows * q, variance: Math.max(variance, 0) };
};

const zOf = (observed, windows, p, k) => {
    const { mean, variance } = windowMoments(windows, p, k);
    return variance > 0 ? (observed - mean) / Math.sqrt(variance) : 0;
};

/**
 * @param {number[]} prices oldest first
 * @param {number} decimals the symbol's price precision (for last digits)
 * @returns {{ n: number, min_run: number, recent_ticks: number, rows: object[], ranked: string[] }}
 */
export function computeRunFrequencies(prices, decimals = 2, k = RUN_MIN) {
    const n = Math.max(0, prices.length - 1);
    let ties = 0;
    for (let i = 1; i < prices.length; i++) if (prices[i] === prices[i - 1]) ties += 1;
    const tie_share = n ? ties / n : 0;
    const windows = Math.max(0, n - k + 1);
    const rows = RUN_CONTRACTS.map(c => {
        const flags = [];
        for (let i = 1; i < prices.length; i++) flags.push(favours(c.key, prices[i], prices[i - 1], decimals));
        const all = scanFlags(flags, k);
        const share = n ? flags.filter(Boolean).length / n : 0;
        // A fair market: every digit tick has a 50% chance of favouring Even/Odd/Over 4/Under 5; a Rise (Fall) tick has half of the non-tie moves.
        const fair = c.key === 'rise' || c.key === 'fall' ? (1 - tie_share) / 2 : 0.5;
        const recent_flags = flags.slice(-RECENT_TICKS);
        const recent = scanFlags(recent_flags, k);
        const recent_windows = Math.max(0, recent_flags.length - k + 1);
        let z = null;
        let cluster_z = null;
        let recent_z = null;
        if (n >= MIN_RUN_SAMPLE) {
            z = round2(zOf(all.triples, windows, fair, k));
            cluster_z = round2(zOf(all.triples, windows, share, k));
            recent_z = round2(zOf(recent.triples, recent_windows, fair, k));
        }
        return {
            key: c.key,
            label: c.label,
            contract_types: c.contract_types,
            triples: all.triples,
            windows,
            pct: windows ? round2((all.triples / windows) * 100) : 0,
            expected_pct: round2(fair ** k * 100),
            runs: all.runs,
            runs4: all.runs4,
            runs5: all.runs5,
            longest: all.longest,
            per100: n ? round2((all.runs / n) * 100) : 0,
            current_run: all.current,
            share_pct: round2(share * 100),
            z,
            cluster_z,
            // 0-100: how strongly this market has favoured the contract (z = 5 is 100). Gaps below chance count as 0.
            bias: z === null ? 0 : Math.round(clamp(z * 20, 0, 100)),
            favoured: z !== null && z >= FAVOURED_Z,
            recent_pct: recent_windows ? round2((recent.triples / recent_windows) * 100) : 0,
            recent_z,
        };
    });
    const ranked = [...rows].filter(r => r.z !== null).sort((a, b) => b.z - a.z).map(r => r.key);
    return { n, min_run: k, recent_ticks: RECENT_TICKS, rows, ranked };
}
