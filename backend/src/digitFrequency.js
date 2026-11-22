// Digit frequency. Pure and stateless: reads the last digits of ONE market's rolling price window and reports
//   - how often every digit 0-9 appeared,
//   - the 1st, 2nd and 3rd MOST frequent digit and the LEAST frequent digit (the four "key digits"),
//   - for Even / Odd / Over 4 / Under 5: how many of the four key digits support the contract, how much of the window sat in the
//     contract's digits (its frequency, in %), and a strength % assigned when the frequency is in favour.
//
// Ranking: more appearances first; a tie goes to the digit seen most recently (the market is still showing it). The LEAST frequent
// digit is the one with the fewest appearances; a tie goes to the digit that has not been seen for the longest.
//
// A key digit SUPPORTS a contract when it points towards it:
//   the 1st, 2nd and 3rd most frequent digits support a contract when the digit is one of the contract's digits (Even: 0,2,4,6,8),
//   the least frequent digit supports a contract when it is NOT one of its digits (a rare odd digit leaves the even digits to appear).
// The AI does NOT wait for all four: when DIGIT_MIN_SUPPORT (2) of the four key digits support a contract, that is a BIAS towards it and
// the frequency is IN FAVOUR. The opposite contract (Even/Odd, Over 4/Under 5) can have the same count, so a 2-2 tie goes to the contract
// whose digits filled more of the window (its share); if that is tied too, the contract that holds the 1st (most frequent) digit wins. So
// one of every opposite pair is always favoured once two key digits point to it, and the AI never leans both ways.
// Strength % (what the AI ranks by): 20 for 2 supporting digits, 40 for 3, 60 for 4, plus 2 points for every % the contract's digits
// are above half of the window, capped at 100.
//
// This describes the last few hundred ticks of a random process. With about 30 ticks per digit in a 300-tick window the gap between
// the most and the least frequent digit is mostly noise; it is a consistent, fast signal for the AI, not a validated edge.

export const DIGIT_MIN_SUPPORT = 2; // of the 4 key digits: two pointing the same way is already a bias
// Set DIGIT_FREQ_GATE=off to keep the numbers but stop the digit frequency from gating entries (for testing).
export const DIGIT_GATE_ON = (process.env.DIGIT_FREQ_GATE ?? 'on') !== 'off';

export const DIGIT_CONTRACTS = [
    { key: 'even', label: 'Even', digits: [0, 2, 4, 6, 8], opposite: 'odd' },
    { key: 'odd', label: 'Odd', digits: [1, 3, 5, 7, 9], opposite: 'even' },
    { key: 'over4', label: 'Over 4', digits: [5, 6, 7, 8, 9], opposite: 'under5' },
    { key: 'under5', label: 'Under 5', digits: [0, 1, 2, 3, 4], opposite: 'over4' },
];

const round2 = n => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {number[]} digits the last digit of every tick of the window, oldest first
 * @returns null when there are no digits
 */
export function digitFrequency(digits) {
    const n = digits.length;
    if (!n) return null;
    const counts = new Array(10).fill(0);
    const last_seen = new Array(10).fill(-1);
    digits.forEach((d, i) => {
        counts[d] += 1;
        last_seen[d] = i;
    });
    const entry = d => ({ digit: d, count: counts[d], pct: round2((counts[d] / n) * 100) });
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const most = [...order].sort((a, b) => counts[b] - counts[a] || last_seen[b] - last_seen[a] || a - b);
    const fewest = [...order].sort((a, b) => counts[a] - counts[b] || last_seen[a] - last_seen[b] || a - b);
    const first = entry(most[0]);
    const second = entry(most[1]);
    const third = entry(most[2]);
    const least = entry(fewest[0]);
    const top = [first.digit, second.digit, third.digit];
    const contracts = {};
    for (const c of DIGIT_CONTRACTS) {
        const inside = c.digits;
        const supporting = [...top.filter(d => inside.includes(d)), ...(inside.includes(least.digit) ? [] : [least.digit])];
        const support = supporting.length;
        const share = round2((digits.filter(d => inside.includes(d)).length / n) * 100);
        contracts[c.key] = {
            label: c.label,
            support, // how many of the 4 key digits point to this contract
            supporting, // which ones
            share, // % of the window's ticks that ended on this contract's digits
            favoured: false, // set below, once the opposite contract is known
            strength: 0,
        };
    }
    for (const c of DIGIT_CONTRACTS) {
        const mine = contracts[c.key];
        const other = contracts[c.opposite];
        const holds_first = c.digits.includes(first.digit);
        const leads = mine.support > other.support || (mine.support === other.support && (mine.share > other.share || (mine.share === other.share && holds_first)));
        mine.favoured = mine.support >= DIGIT_MIN_SUPPORT && leads;
        mine.strength = mine.favoured ? Math.round(clamp((mine.support - 1) * 20 + Math.max(0, mine.share - 50) * 2, 0, 100)) : 0;
    }
    return { n, counts, pct: counts.map(c => round2((c / n) * 100)), first, second, third, least, key_digits: [first.digit, second.digit, third.digit, least.digit], contracts };
}
