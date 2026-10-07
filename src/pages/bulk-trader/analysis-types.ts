import { TDigitContractType } from './types';

// The non-digit contract families the AI auto-pilot can also trade — added
// alongside the original digit signals, not replacing them. The Digit Matrix
// grid only ever sees family 'digits' entries; the auto-pilot reads all of them.
export type TContractFamily =
    | 'digits'
    | 'rise_fall'
    | 'only_up_down'
    | 'touch'
    | 'ends'
    | 'range'
    | 'asians'
    | 'high_low_tick'
    | 'reset';

export type TContractType =
    | TDigitContractType
    | 'CALL'
    | 'PUT'
    | 'RUNHIGH'
    | 'RUNLOW'
    | 'ONETOUCH'
    | 'NOTOUCH'
    | 'EXPIRYRANGE'
    | 'EXPIRYMISS'
    | 'RANGE'
    | 'UPORDOWN'
    | 'ASIANU'
    | 'ASIAND'
    | 'TICKHIGH'
    | 'TICKLOW'
    | 'RESETCALL'
    | 'RESETPUT';

export type TDigitStats = {
    symbol: string;
    total_ticks: number;
    window_size: number;
    last_updated: string | null;
    last_digit: number | null;
    last_digits: number[];
    recent?: Record<string, { n: number; even_pct: number; odd_pct: number; over4_pct?: number; over5_pct: number; under5_pct: number }>;
    digit_counts: number[];
    digit_percentages: number[];
    expected_pct: number;
    hot_digit: number;
    cold_digit: number;
    even_pct: number;
    odd_pct: number;
    over4_pct?: number;
    over5_pct: number;
    under5_pct: number;
    equal5_pct: number;
    streaks: {
        even: number;
        odd: number;
        over4?: number;
        over5: number;
        under5: number;
        same_as_last: number;
    };
};

export type TDigitSignal = {
    family: TContractFamily;
    contract_type: TContractType;
    /** Only present on the non-digit families — digit signals always trade at 1 tick in this app. */
    duration_ticks?: number;
    /** A barrier/prediction value. Digits and High/Low Tick use a number
     *  (predicted digit, or selected_tick); Touch/No Touch and Ends
     *  Between/Outside use a signed offset string (e.g. "+1.5"). */
    prediction?: number | string;
    label: string;
    confidence: number;
    basis: string;
    /** Set when a signal comes from a named playbook strategy (e.g. 'streak_reversal'), so the learner scores it on its own. */
    strategy?: string;
};

export type TSymbolSnapshot = {
    stats: TDigitStats;
    signals: TDigitSignal[];
};

export type TSnapshotMap = Record<string, TSymbolSnapshot>;

export type TConnectionState = 'connecting' | 'open' | 'closed' | 'unconfigured';
