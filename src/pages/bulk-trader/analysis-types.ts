import { TDigitContractType } from './types';

export type TDigitStats = {
    symbol: string;
    total_ticks: number;
    window_size: number;
    last_updated: string | null;
    last_digit: number | null;
    last_digits: number[];
    digit_counts: number[];
    digit_percentages: number[];
    expected_pct: number;
    hot_digit: number;
    cold_digit: number;
    even_pct: number;
    odd_pct: number;
    over5_pct: number;
    under5_pct: number;
    equal5_pct: number;
    streaks: {
        even: number;
        odd: number;
        over5: number;
        under5: number;
        same_as_last: number;
    };
};

export type TDigitSignal = {
    contract_type: TDigitContractType;
    prediction?: number;
    label: string;
    confidence: number;
    basis: string;
};

export type TSymbolSnapshot = {
    stats: TDigitStats;
    signals: TDigitSignal[];
};

export type TSnapshotMap = Record<string, TSymbolSnapshot>;

export type TConnectionState = 'connecting' | 'open' | 'closed' | 'unconfigured';
