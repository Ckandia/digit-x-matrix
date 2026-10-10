// Pure, stateless statistics helpers over a rolling window of last-digits for one
// symbol. No Deriv/network concerns live here — marketFeed.js owns the window and
// calls into this file whenever a new tick digit arrives.

export const WINDOW_SIZE = 500; // how many recent ticks we keep per symbol
export const MIN_SAMPLE_FOR_SIGNAL = 60; // don't emit signals until we have enough data

/** Creates an empty rolling window for one symbol. */
export function createDigitWindow() {
    return {
        digits: [], // most recent last, length <= WINDOW_SIZE
        counts: new Array(10).fill(0), // counts[d] = occurrences of digit d in `digits`
        last_updated: null,
    };
}

/** Pushes a new last-digit (0-9) into the window, evicting the oldest if full. */
export function pushDigit(window, digit) {
    if (digit < 0 || digit > 9 || !Number.isInteger(digit)) return window;
    window.digits.push(digit);
    window.counts[digit] += 1;
    if (window.digits.length > WINDOW_SIZE) {
        const evicted = window.digits.shift();
        window.counts[evicted] -= 1;
    }
    window.last_updated = new Date().toISOString();
    return window;
}

/** Longest-running streak at the end of the digit list matching `predicate`. */
function trailingStreak(digits, predicate) {
    let count = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
        if (predicate(digits[i])) count += 1;
        else break;
    }
    return count;
}

/**
 * Full snapshot of stats for one symbol's current window: per-digit frequency,
 * even/odd + over/under splits, hot/cold digits, and trailing streaks. This is
 * what gets sent to the frontend and fed into computeSignals().
 */
export function computeStats(window, symbol) {
    const total = window.digits.length;
    const percentages = window.counts.map(c => (total ? Number(((c / total) * 100).toFixed(2)) : 0));
    const expected_pct = 10; // uniform baseline for a fair 0-9 digit

    let hot_digit = 0;
    let cold_digit = 0;
    for (let d = 1; d < 10; d++) {
        if (window.counts[d] > window.counts[hot_digit]) hot_digit = d;
        if (window.counts[d] < window.counts[cold_digit]) cold_digit = d;
    }

    const even_count = window.digits.filter(d => d % 2 === 0).length;
    const odd_count = total - even_count;
    const over5_count = window.digits.filter(d => d > 5).length;
    const under5_count = window.digits.filter(d => d < 5).length;
    const equal5_count = total - over5_count - under5_count;
    // Over 4 = last digit 5-9, Under 5 = last digit 0-4: exactly complementary, 50% each on a fair digit.
    const over4_count = window.digits.filter(d => d > 4).length;

    const last_digits = window.digits.slice(-30);

    // Shorter, most-recent windows. These DESCRIBE what just happened (e.g. "even was 80% of
    // the last 25 ticks"); they do not predict the next digit. The frontend learner records
    // whether acting on such skews has actually paid, so the numbers are judged on results.
    const recent = {};
    for (const n of [25, 50, 100]) {
        const slice = window.digits.slice(-n);
        const m = slice.length;
        const pct = c => (m ? Number(((c / m) * 100).toFixed(1)) : 0);
        recent[`n${n}`] = {
            n: m,
            even_pct: pct(slice.filter(d => d % 2 === 0).length),
            odd_pct: pct(slice.filter(d => d % 2 !== 0).length),
            over4_pct: pct(slice.filter(d => d > 4).length),
            over5_pct: pct(slice.filter(d => d > 5).length),
            under5_pct: pct(slice.filter(d => d < 5).length),
        };
    }

    return {
        symbol,
        total_ticks: total,
        window_size: WINDOW_SIZE,
        last_updated: window.last_updated,
        last_digit: total ? window.digits[total - 1] : null,
        last_digits,
        recent,
        digit_counts: [...window.counts],
        digit_percentages: percentages,
        expected_pct,
        hot_digit,
        cold_digit,
        even_pct: total ? Number(((even_count / total) * 100).toFixed(2)) : 0,
        odd_pct: total ? Number(((odd_count / total) * 100).toFixed(2)) : 0,
        over4_pct: total ? Number(((over4_count / total) * 100).toFixed(2)) : 0,
        over5_pct: total ? Number(((over5_count / total) * 100).toFixed(2)) : 0,
        under5_pct: total ? Number(((under5_count / total) * 100).toFixed(2)) : 0,
        equal5_pct: total ? Number(((equal5_count / total) * 100).toFixed(2)) : 0,
        streaks: {
            even: trailingStreak(window.digits, d => d % 2 === 0),
            odd: trailingStreak(window.digits, d => d % 2 !== 0),
            over4: trailingStreak(window.digits, d => d > 4),
            over5: trailingStreak(window.digits, d => d > 5),
            under5: trailingStreak(window.digits, d => d < 5),
            same_as_last: total ? trailingStreak(window.digits, d => d === window.digits[total - 1]) : 0,
        },
    };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Confidence score (0-100) from how far an observed percentage sits from its
 * fair-RNG expected percentage, scaled by sample size. This is a *statistical
 * deviation* score, not a probability of winning — digit outcomes on Deriv's
 * synthetic indices are independent draws, so past frequency does not change
 * the odds of the next tick. We surface deviations because that's what a
 * digit-matrix tool is for, but every signal is labelled accordingly.
 */
function deviationConfidence(observed_pct, expected_pct, sample_size) {
    const deviation = Math.abs(observed_pct - expected_pct);
    const sample_factor = clamp(sample_size / MIN_SAMPLE_FOR_SIGNAL, 0, 2.5);
    return Math.round(clamp(deviation * sample_factor * 2.2, 0, 100));
}

/**
 * Turns a stats snapshot into a ranked list of candidate signals across every
 * digit contract type Bulk Trader supports. Returns [] until MIN_SAMPLE_FOR_SIGNAL
 * ticks have been collected. Each signal carries a `confidence` (see above),
 * never a win probability or guarantee.
 */
export function computeSignals(stats) {
    if (stats.total_ticks < MIN_SAMPLE_FOR_SIGNAL) return [];

    const signals = [];

    // Even / Odd — bet on the side currently under its 50% baseline.
    const even_conf = deviationConfidence(stats.even_pct, 50, stats.total_ticks);
    if (stats.odd_pct >= stats.even_pct && even_conf >= 15) {
        signals.push({
            contract_type: 'DIGITEVEN',
            label: 'Even',
            confidence: even_conf,
            basis: `Even has printed ${stats.even_pct}% of the last ${stats.total_ticks} ticks vs a 50% baseline.`,
        });
    } else if (even_conf >= 15) {
        signals.push({
            contract_type: 'DIGITODD',
            label: 'Odd',
            confidence: even_conf,
            basis: `Odd has printed ${stats.odd_pct}% of the last ${stats.total_ticks} ticks vs a 50% baseline.`,
        });
    }

    // Over 4 / Under 5 — the two halves of the digit range (5-9 vs 0-4), 50% each on a fair digit.
    // Same deviation logic as Even/Odd: bet the side currently under its 50% baseline.
    const half_conf = deviationConfidence(stats.under5_pct, 50, stats.total_ticks);
    if (stats.under5_pct >= stats.over4_pct && half_conf >= 15) {
        signals.push({
            contract_type: 'DIGITOVER',
            prediction: 4,
            label: 'Over 4',
            confidence: half_conf,
            basis: `Over 4 (digits 5-9) has printed ${stats.over4_pct}% of the last ${stats.total_ticks} ticks vs a 50% baseline.`,
        });
    } else if (half_conf >= 15) {
        signals.push({
            contract_type: 'DIGITUNDER',
            prediction: 5,
            label: 'Under 5',
            confidence: half_conf,
            basis: `Under 5 (digits 0-4) has printed ${stats.under5_pct}% of the last ${stats.total_ticks} ticks vs a 50% baseline.`,
        });
    }

    // Differs — the "hot" digit is the one most over-represented; Differs on it
    // has the smallest deviation-implied edge against it repeating again.
    const hot_pct = stats.digit_percentages[stats.hot_digit];
    const hot_conf = deviationConfidence(hot_pct, stats.expected_pct, stats.total_ticks);
    if (hot_conf >= 15) {
        signals.push({
            contract_type: 'DIGITDIFF',
            prediction: stats.hot_digit,
            label: `Differs from ${stats.hot_digit}`,
            confidence: hot_conf,
            basis: `Digit ${stats.hot_digit} has printed ${hot_pct}% of the last ${stats.total_ticks} ticks vs a ${stats.expected_pct}% baseline.`,
        });
    }

    // Matches — the "cold" digit is the most under-represented; a Matches bet on
    // it is a "due for reversion" style signal, flagged with lower confidence.
    const cold_pct = stats.digit_percentages[stats.cold_digit];
    const cold_conf = deviationConfidence(stats.expected_pct, cold_pct, stats.total_ticks);
    if (cold_conf >= 15) {
        signals.push({
            contract_type: 'DIGITMATCH',
            prediction: stats.cold_digit,
            label: `Matches ${stats.cold_digit}`,
            confidence: Math.round(cold_conf * 0.7), // matches has 1/10 base odds — weight down
            basis: `Digit ${stats.cold_digit} has printed only ${cold_pct}% of the last ${stats.total_ticks} ticks vs a ${stats.expected_pct}% baseline.`,
        });
    }

    return signals.sort((a, b) => b.confidence - a.confidence);
}
