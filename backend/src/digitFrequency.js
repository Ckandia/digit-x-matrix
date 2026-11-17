// Digit frequency. Pure and stateless: reads a rolling window of raw prices for ONE symbol and reports how often each last digit
// (0-9) appeared: the 1st, 2nd and 3rd MOST appearing digit and the LEAST appearing digit, each with its count and its % of the window.
//
// On top of that, the owner's frequency logic for the four digit contracts (Even, Odd, Over 4, Under 5), built from those four digits:
//   Even  = digits 0 2 4 6 8      Odd    = digits 1 3 5 7 9
//   Over 4 = digits 5 6 7 8 9     Under 5 = digits 0 1 2 3 4
//   Each of the four digits either FAVOURS a contract or not:
//     - the 1st, 2nd and 3rd most appearing digit favour a contract when the digit belongs to it;
//     - the least appearing digit favours a contract when it does NOT belong to it (the digit that shows up least is on the other side).
//   `agree` = how many of the four digits favour the contract (0-4). Not all four have to agree: a contract is FAVOURED when at least 2 of
//   the 4 favour it and it is ahead of its opposite (Even vs Odd, Over 4 vs Under 5). A 2-2 split favours neither (verdict 'split').
//   The favoured contract gets a CONFIDENCE BOOST (see runBias.js); the digits never delay or block an entry.
//
// This DESCRIBES the last ~500 ticks. Deriv's synthetic indices draw each digit independently, so a digit that has been frequent is
// not more likely on the next tick: the numbers are a report, not a validated edge, and nothing here places a trade.

import { inferDecimals, lastDigit } from './runBias.js';

export const DIGIT_WINDOW = 500; // ticks the frequencies are measured on (the same size as the digit window)
export const MIN_DIGIT_SAMPLE = 60; // ticks needed before anything is reported
export const AGREE_NEEDED = 2; // of the four digits (1st, 2nd, 3rd most and least appearing), at least this many must favour the contract

export const DIGIT_CONTRACTS = [
    { key: 'even', contract_type: 'DIGITEVEN', label: 'Even', digits: [0, 2, 4, 6, 8], pair: 'odd' },
    { key: 'odd', contract_type: 'DIGITODD', label: 'Odd', digits: [1, 3, 5, 7, 9], pair: 'even' },
    { key: 'over4', contract_type: 'DIGITOVER', label: 'Over 4', digits: [5, 6, 7, 8, 9], pair: 'under5' },
    { key: 'under5', contract_type: 'DIGITUNDER', label: 'Under 5', digits: [0, 1, 2, 3, 4], pair: 'over4' },
];

const round2 = n => Math.round(n * 100) / 100;

/** The ten digits ranked from most to least appearing. Ties: the digit seen more recently ranks higher, then the lower digit. */
export function rankDigits(digits) {
    const n = digits.length;
    const count = new Array(10).fill(0);
    const last_seen = new Array(10).fill(-1);
    digits.forEach((d, i) => {
        count[d] += 1;
        last_seen[d] = i;
    });
    const ranked = count
        .map((c, digit) => ({ digit, count: c, pct: n ? round2((c / n) * 100) : 0, last_seen: last_seen[digit] }))
        .sort((a, b) => b.count - a.count || b.last_seen - a.last_seen || a.digit - b.digit);
    // `tied` = how many OTHER digits share this digit's count (so the reader knows the rank is a tie-break, not a clear gap)
    return ranked.map(r => ({ digit: r.digit, count: r.count, pct: r.pct, tied: count.filter(c => c === r.count).length - 1 }));
}

/** The frequency logic for one contract, given the ranking (see the header). `opposite_agree` is the count for the opposite contract of its pair. */
export function contractLogic(def, ranked, n, counts) {
    const top3 = ranked.slice(0, 3);
    const least = ranked[ranked.length - 1];
    const top3_votes = top3.filter(r => def.digits.includes(r.digit)).length;
    const least_inside = def.digits.includes(least.digit);
    const agree = top3_votes + (least_inside ? 0 : 1); // how many of the four digits favour this contract (0-4)
    const hits = def.digits.reduce((sum, d) => sum + counts[d], 0);
    const pct = n ? round2((hits / n) * 100) : 0;
    return { key: def.key, contract_type: def.contract_type, label: def.label, pct, top3_votes, least_inside, agree };
}

/** Adds `favoured` and `verdict` once both contracts of a pair have their `agree`: favoured = at least AGREE_NEEDED of the four digits AND ahead of the opposite. */
export function judgeLogic(logic) {
    const by = Object.fromEntries(logic.map(l => [l.key, l]));
    return logic.map(l => {
        const opposite = by[DIGIT_CONTRACTS.find(d => d.key === l.key).pair];
        const favoured = l.agree >= AGREE_NEEDED && l.agree > opposite.agree;
        const verdict = favoured ? 'favoured' : l.agree >= AGREE_NEEDED && l.agree === opposite.agree ? 'split' : 'none';
        return { ...l, favoured, verdict };
    });
}

/**
 * @param {number[]} prices oldest first
 * @param {number} decimals the symbol's reported price precision (only a fallback: the real one is read from the prices)
 */
export function computeDigitFrequency(prices, decimals = 2) {
    const tail = prices.slice(-DIGIT_WINDOW);
    const n = tail.length;
    if (n < MIN_DIGIT_SAMPLE) return { n, ranking: [], logic: [] };
    const seen_dp = inferDecimals(tail);
    const dp = seen_dp > 0 && seen_dp <= 8 ? seen_dp : Number.isInteger(decimals) ? decimals : 2;
    const digits = tail.map(p => lastDigit(p, dp));
    const counts = new Array(10).fill(0);
    for (const d of digits) counts[d] += 1;
    const ranked = rankDigits(digits);
    const logic = judgeLogic(DIGIT_CONTRACTS.map(def => contractLogic(def, ranked, n, counts)));
    // Convenience: which side of each pair the four digits favour (null = mixed / no clear side)
    const favours = (a, b) => (logic.find(l => l.key === a)?.favoured ? a : logic.find(l => l.key === b)?.favoured ? b : null);
    return {
        n,
        decimals: dp,
        ranking: ranked, // all ten digits, most appearing first
        first: ranked[0],
        second: ranked[1],
        third: ranked[2],
        least: ranked[9],
        logic,
        even_odd: favours('even', 'odd'),
        over_under: favours('over4', 'under5'),
        last_digit: digits[digits.length - 1],
    };
}
