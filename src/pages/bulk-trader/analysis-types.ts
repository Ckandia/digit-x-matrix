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
    | 'pairs'
    | 'run_bias';

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
    /** run_bias family only: true when 3 or more ticks in a row favour this contract RIGHT NOW in a market whose bias favours it. The AI buys on it. */
    entry?: boolean;
    /** run_bias family only: the digit sequence favours TWO contracts at once (Even + Under 5, Odd + Over 4); the AI buys both together. */
    pair_types?: string[];
    /** run_bias pair signals: which of the five pairs this is (even_under5, odd_over4, rise_odd, fall_even). */
    pair_key?: string;
    /** Basket bases only: the backend judged the whole 3-contract basket (digit pair + third contract + replayed basket result) and it may be bought. */
    basket_entry?: boolean;
    /** Basket bases only: which of the 16 setups this signal is (null = no chart direction). The AI checks it against its own table. */
    basket_setup?: number | null;
    /** Rise / Only Ups need a bullish chart, Fall / Only Downs a bearish one; basket signals carry the chart direction here. */
    momentum?: boolean;
    trend?: string;
    /** run_bias family only: every analysed run length of this contract (2 AND 3 ticks for the digit contracts) favours it at once. */
    confluence?: boolean;
    /** run_bias family only: the run lengths alone agree (the old `confluence`), before the four digits are counted. */
    levels_confluence?: boolean;
    /** Even / Odd / Over 4 / Under 5 (and the pairs made of them): at least 2 of the four digits (1st / 2nd / 3rd most appearing, least appearing) favour this contract. `confluence` needs this too. */
    digit_confluence?: boolean;
    /** Confidence points the digits added (5 / 10 / 15 for 2 / 3 / 4 of the four digits favouring the contract; 0 otherwise). Never changes `entry`. */
    digit_boost?: number;
    /** The confidence before the digit boost. */
    base_confidence?: number;
    digit_freq?: { agree: number; top3_votes: number; least_inside: boolean; pct: number; verdict: 'favoured' | 'split' | 'none' };
    /** run_bias family only: which run of ticks this is (the tick count when it started), so one run is traded once. */
    run_id?: number | string;
    /** run_bias family only: the numbers behind the signal (`min_run` = the run length this signal was measured on). */
    run?: { current: number; runs: number; ticks_in_runs: number; longest: number; bias: number; min_run?: number; outcomes?: number; wins?: number; hit?: number | null; pattern?: string[] };
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

/** One digit of the backend's digit-frequency ranking (see backend/src/digitFrequency.js). `tied` = how many other digits share its count. */
export type TDigitRank = { digit: number; count: number; pct: number; tied: number };

/** The frequency logic of one digit contract. `agree` = how many of the four digits (1st / 2nd / 3rd most appearing, least appearing) favour it; favoured = at least 2 of the 4 AND ahead of its opposite. */
export type TDigitLogic = {
    key: 'even' | 'odd' | 'over4' | 'under5';
    contract_type: string;
    label: string;
    /** % of the window's ticks that fell on this contract's digits. */
    pct: number;
    /** How many of the 3 most appearing digits belong to this contract (0-3). */
    top3_votes: number;
    /** The least appearing digit belongs to this contract (so it does NOT favour it). */
    least_inside: boolean;
    /** How many of the four digits favour this contract (0-4): the top-3 digits that belong to it, plus 1 when the least appearing digit is on the other side. */
    agree: number;
    favoured: boolean;
    /** favoured = at least 2 of 4 and ahead of the opposite; split = 2 of 4 but level with the opposite (a 2-2 split favours neither); none = fewer than 2. */
    verdict: 'favoured' | 'split' | 'none';
};

/** The backend's digit frequency for one market: 1st / 2nd / 3rd most appearing digit, the least appearing digit, and the Even / Odd / Over 4 / Under 5 logic. */
export type TDigitFreq = {
    n: number;
    decimals?: number;
    ranking: TDigitRank[];
    first?: TDigitRank;
    second?: TDigitRank;
    third?: TDigitRank;
    least?: TDigitRank;
    logic: TDigitLogic[];
    even_odd?: 'even' | 'odd' | null;
    over_under?: 'over4' | 'under5' | null;
    last_digit?: number;
};

export type TSymbolSnapshot = {
    stats: TDigitStats;
    signals: TDigitSignal[];
    /** Two-tick pair frequencies for the ten contracts on this market. */
    pairs?: TPairScan;
    /** The backend's run bias: how often 3+ ticks in a row favoured each contract (see backend/src/runBias.js). */
    run_bias?: TRunBias;
    /** Digit frequency: the most and least appearing digits and the Even / Odd / Over 4 / Under 5 frequency logic (see backend/src/digitFrequency.js). */
    digit_freq?: TDigitFreq;
};

export type TRunBiasRow = {
    key: string;
    contract_type: string;
    label: string;
    runs: number;
    ticks_in_runs: number;
    longest: number;
    current: number;
    /** Bias on the shortest run length this contract is analysed on. */
    bias: number;
    /** The same numbers per analysed run length: Even/Odd and Over 4/Under 5 on 2 AND 3 ticks, the others from 2. Bias = share (%) of all run ticks of the pair: 50 = balanced, higher = more favoured. */
    levels?: { min_run: number; runs: number; ticks_in_runs: number; bias: number; outcomes?: number; wins?: number; hit?: number | null }[];
    run_start?: number | null;
};
export type TRunBias = { n: number; min_run: number; pairs?: (Omit<TRunBiasRow, 'contract_type'> & { types: string[] })[]; /** Decimal places this market really prints, read from its own prices. */ decimals?: number; reported_decimals?: number; rows: TRunBiasRow[] };

export type TSnapshotMap = Record<string, TSymbolSnapshot>;

export type TConnectionState = 'connecting' | 'open' | 'closed' | 'unconfigured';
