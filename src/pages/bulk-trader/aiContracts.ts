// What the AI auto-pilot adds on top of the backend's signals: the Over 4 / Under 5 market, Higher / Lower
// and Multipliers, the trend each directional contract needs, and the contract each one switches with.
// (The backend only scores the contracts it knows; these are produced here, from the same live stats.)
import type { TContractType, TDigitSignal, TSymbolSnapshot } from './analysis-types';
import type { TTrendSide } from './contractSpecs';

/** Contracts that bet on direction: only bought when the 1-tick chart confirms the matching trend. */
const TREND_SIDE: Record<string, TTrendSide> = {
    CALL: 'bullish',
    PUT: 'bearish',
    HIGHER: 'bullish',
    LOWER: 'bearish',
    MULTUP: 'bullish',
    MULTDOWN: 'bearish',
    RUNHIGH: 'bullish',
    RUNLOW: 'bearish',
    ASIANU: 'bullish',
    ASIAND: 'bearish',
    RESETCALL: 'bullish',
    RESETPUT: 'bearish',
};
export const trendSideOf = (contract_type: string): TTrendSide | undefined => TREND_SIDE[contract_type];

const MIN_SAMPLE_FOR_SIGNAL = 60; // same as the backend
/** Trend contracts have no digit statistics behind them: this is only a tie-breaker, never a win probability. */
export const TREND_SIGNAL_CONFIDENCE = 40;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Same deviation score the backend uses for its digit signals.
const deviationConfidence = (observed: number, expected: number, sample: number) =>
    Math.round(clamp(Math.abs(observed - expected) * clamp(sample / MIN_SAMPLE_FOR_SIGNAL, 0, 2.5) * 2.2, 0, 100));

/**
 * The signals the AI adds for one market:
 *  - Over 4 or Under 5 (the side currently printing LESS than its 50%, like the backend's Even/Odd and Over/Under
 *    signals). They are exact opposites: Over 4 = last digit 5-9, Under 5 = last digit 0-4.
 *  - Higher, Lower, Multiplier Up, Multiplier Down. These carry no statistics; they are in the pool so the AI can
 *    trade them, and the trend gate (the engine's job) decides when each one is allowed.
 */
export const extraSignals = (snapshot: TSymbolSnapshot): TDigitSignal[] => {
    const out: TDigitSignal[] = [];
    const stats = snapshot.stats;
    if (stats && stats.total_ticks >= MIN_SAMPLE_FOR_SIGNAL) {
        const under5 = stats.under5_pct;
        const over4 = stats.over5_pct + (stats.equal5_pct ?? Math.max(0, 100 - stats.over5_pct - stats.under5_pct));
        const bet_over = under5 >= over4; // bet the lagging side
        const conf = deviationConfidence(bet_over ? over4 : under5, 50, stats.total_ticks);
        if (conf >= 15) {
            out.push({
                family: 'digits',
                contract_type: bet_over ? 'OVER4' : 'UNDER5',
                prediction: bet_over ? 4 : 5,
                label: bet_over ? 'Over 4' : 'Under 5',
                confidence: conf,
                basis: `${bet_over ? 'Over 4' : 'Under 5'} has printed ${(bet_over ? over4 : under5).toFixed(1)}% of the last ${stats.total_ticks} ticks vs a 50% baseline.`,
            });
        }
    }
    const trend = (contract_type: TContractType, label: string, family: TDigitSignal['family'], prediction?: string): TDigitSignal => ({
        family,
        contract_type,
        prediction,
        label,
        confidence: TREND_SIGNAL_CONFIDENCE,
        basis: 'Trend contract: only offered while the 1-tick chart confirms the trend.',
    });
    out.push(
        trend('HIGHER', 'Higher', 'rise_fall', '+0.1'),
        trend('LOWER', 'Lower', 'rise_fall', '-0.1'),
        trend('MULTUP', 'Multiplier Up', 'multiplier'),
        trend('MULTDOWN', 'Multiplier Down', 'multiplier')
    );
    return out;
};

const SYNTH: Record<string, { family: TDigitSignal['family']; label: string; prediction?: number | string }> = {
    DIGITEVEN: { family: 'digits', label: 'Even' },
    DIGITODD: { family: 'digits', label: 'Odd' },
    OVER4: { family: 'digits', label: 'Over 4', prediction: 4 },
    UNDER5: { family: 'digits', label: 'Under 5', prediction: 5 },
    CALL: { family: 'rise_fall', label: 'Rise' },
    PUT: { family: 'rise_fall', label: 'Fall' },
    HIGHER: { family: 'rise_fall', label: 'Higher', prediction: '+0.1' },
    LOWER: { family: 'rise_fall', label: 'Lower', prediction: '-0.1' },
    ONETOUCH: { family: 'touch', label: 'Touch', prediction: '+0.5' },
    NOTOUCH: { family: 'touch', label: 'No Touch', prediction: '+0.5' },
    MULTUP: { family: 'multiplier', label: 'Multiplier Up' },
    MULTDOWN: { family: 'multiplier', label: 'Multiplier Down' },
};

/** A signal for a switch target when the analysis has no live signal for it right now (switching must always be able to fire). */
export const synthSignal = (contract_type: string): TDigitSignal | null => {
    const s = SYNTH[contract_type];
    if (!s) return null;
    return {
        family: s.family,
        contract_type: contract_type as TContractType,
        prediction: s.prediction,
        label: `${s.label} (switched)`,
        confidence: 0,
        basis: 'Switching partner of the contract that just lost.',
    };
};
