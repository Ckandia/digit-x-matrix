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
    | 'reset'
    | 'pairs';

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

/** One contract's row of the backend's two-tick pair scan (see backend/src/pairScan.js). */
export type TPairRow = {
    key: string;
    contract_type: string;
    label: string;
    hits: number;
    /** % of the two-tick windows in which the pattern showed up on both consecutive ticks. */
    pct: number;
    /** What chance alone would give (null until enough ticks are in). */
    expected_pct: number | null;
    z: number | null;
};

export type TPairScan = { n: number; barrier: number; rows: TPairRow[] };

/** One contract's row of the backend's run scan (see backend/src/runScan.js): appearances of 3+ consecutive favouring ticks. */
export type TRunRow = {
    key: string;
    label: string;
    contract_types: string[];
    /** Three-tick windows in which all three ticks favoured the contract (a run of 6 holds four). */
    triples: number;
    windows: number;
    /** % of the three-tick windows that were all in the contract's favour. */
    pct: number;
    /** What a fair market gives (12.5% for the digit contracts). */
    expected_pct: number;
    /** Separate runs of 3 or more, how many reached 4 and 5, the longest run, and runs per 100 ticks. */
    runs: number;
    runs4: number;
    runs5: number;
    longest: number;
    per100: number;
    /** The run in progress at the newest tick (2 = the next favouring tick makes three). */
    current_run: number;
    share_pct: number;
    /** Gap to a fair market in standard errors: the market bias. Null until enough ticks are in. */
    z: number | null;
    /** The same gap against this market's own single-tick rate (is it clustering more than its rate explains?). */
    cluster_z: number | null;
    /** 0-100, from z. */
    bias: number;
    favoured: boolean;
    recent_pct: number;
    recent_z: number | null;
};

export type TRunScan = { n: number; min_run: number; recent_ticks: number; rows: TRunRow[]; ranked: string[] };

export type TSymbolSnapshot = {
    stats: TDigitStats;
    signals: TDigitSignal[];
    /** Two-tick pair frequencies for the ten contracts on this market. */
    pairs?: TPairScan;
    /** Three-or-more-tick run frequencies (market bias) for the six ticked contracts. */
    runs?: TRunScan;
};

export type TSnapshotMap = Record<string, TSymbolSnapshot>;

export type TConnectionState = 'connecting' | 'open' | 'closed' | 'unconfigured';
