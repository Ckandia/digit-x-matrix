// The owner's Even/Odd "snap-back" playbook (from the Build.docx notes), as a signal.
//
// The notes: digits split evenly 5 even / 5 odd, so a long run of one parity leaves the short-term
// window lopsided, and a reversal is the classic trade. They also warn about the gambler's fallacy
// ("a raw random stream can sustain a long streak longer than intuition expects") and say
// professional systems do NOT bet after 2 evens: they wait for a rare 5+ streak, combined with
// tick speed slowing, before playing the reversion.
//
// Rule implemented:
//   1. The trailing run of one parity is at least STREAK_MIN (5) digits long, and
//   2. tick speed has slowed: the average absolute price change over the last VELOCITY_RECENT
//      ticks is below SLOW_RATIO of the average over the VELOCITY_BASELINE ticks before them.
//      (Deriv's synthetic indices tick at a fixed interval, so "speed" here is price speed.)
//   -> bet the OPPOSITE parity (the reversal).
//
// HONEST LIMIT: last digits of Deriv's synthetic indices are independent draws, so a streak does
// not change the next digit's odds, and price speed has no link to the digit at all. This is the
// owner's rule, implemented faithfully; it is NOT a proven edge. The signal is tagged
// strategy: 'streak_reversal' so the frontend learner records its wins and losses on their own,
// and 'edge_gate' mode will only trade it once its real results beat break-even.
//
// Keep these numbers in step with STREAK_PLAYBOOK in src/pages/bulk-trader/tradingKnowledge.ts.
import { MIN_SAMPLE_FOR_SIGNAL } from './digitAnalysis.js';

export const STREAK_MIN = 5;
export const VELOCITY_RECENT = 5;
export const VELOCITY_BASELINE = 20;
export const SLOW_RATIO = 0.8;

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** recent / baseline average absolute tick-to-tick price change, or null when it cannot be measured. */
export function tickSpeedRatio(prices) {
    const need = VELOCITY_RECENT + VELOCITY_BASELINE + 1;
    if (!Array.isArray(prices) || prices.length < need) return null;
    const diffs = [];
    for (let i = prices.length - (VELOCITY_RECENT + VELOCITY_BASELINE); i < prices.length; i++) {
        diffs.push(Math.abs(prices[i] - prices[i - 1]));
    }
    const baseline = mean(diffs.slice(0, VELOCITY_BASELINE));
    if (!(baseline > 0)) return null; // flat or stale feed: nothing to compare against
    return mean(diffs.slice(VELOCITY_BASELINE)) / baseline;
}

/** The streak-reversal signal for one symbol, or null when the playbook's conditions are not all met. */
export function computeStreakSignal(stats, priceWindow) {
    if (!stats || stats.total_ticks < MIN_SAMPLE_FOR_SIGNAL || !stats.streaks) return null;
    const even = stats.streaks.even;
    const odd = stats.streaks.odd;
    const streak = Math.max(even, odd);
    if (streak < STREAK_MIN) return null;

    const ratio = tickSpeedRatio(priceWindow?.prices);
    if (ratio === null || ratio >= SLOW_RATIO) return null;

    const run_is_even = even >= odd;
    const reversal_type = run_is_even ? 'DIGITODD' : 'DIGITEVEN';
    const confidence = Math.round(clamp(40 + (streak - STREAK_MIN) * 12 + (SLOW_RATIO - ratio) * 25, 0, 100));
    return {
        family: 'digits',
        contract_type: reversal_type,
        strategy: 'streak_reversal',
        label: `${run_is_even ? 'Odd' : 'Even'} (streak reversal)`,
        confidence,
        basis:
            `${run_is_even ? 'Even' : 'Odd'} has printed ${streak} in a row and tick speed has slowed to ${ratio.toFixed(2)}x its recent average: ` +
            `the playbook bets the ${run_is_even ? 'odd' : 'even'} snap-back. Digits are independent, so this is a rule from your notes, ` +
            `not a measured edge; its results are tracked separately.`,
    };
}
