export type TDigitContractType = 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITEVEN' | 'DIGITODD';

/**
 * Everything the Bulk Trader tab can run. The first six are the digit contracts the tab always had.
 * The rest are keys of ours (see contractSpecs.ts): OVER4 / UNDER5 are digit Over/Under with the
 * barrier fixed; HIGHER / LOWER are Deriv's CALL / PUT with a barrier (kept as separate keys so they
 * are never confused with Rise / Fall, which share the same Deriv codes).
 */
export type TBulkContractType =
    | TDigitContractType
    | 'OVER4'
    | 'UNDER5'
    | 'CALL'
    | 'PUT'
    | 'HIGHER'
    | 'LOWER'
    | 'ONETOUCH'
    | 'NOTOUCH'
    | 'RUNHIGH'
    | 'RUNLOW'
    | 'MULTUP'
    | 'MULTDOWN';

export type TMoneyManagement = 'flat' | 'martingale' | 'dalembert';

export type TStrategyConfig = {
    /** Client-side only id (uuid) used before the backend assigns its own. */
    client_id: string;
    label: string;
    symbol: string;
    contract_type: TBulkContractType;
    /** Predicted digit (0-9). Required for DIGITMATCH / DIGITDIFF / DIGITOVER / DIGITUNDER. */
    prediction: number;
    stake: number;
    /** Contract duration in ticks (Deriv digit contracts are duration_unit: 't'). */
    duration_ticks: number;
    money_management: TMoneyManagement;
    /** Multiplier applied to stake after a loss (martingale) or step size (d'alembert). */
    multiplier: number;
    /** After a loss, switches to this contract's partner (Even<->Over 4, Odd<->Under 5, Touch<->Under 5, ...) and back after the next loss. */
    auto_flip: boolean;
    /** Shortens the pause between trades from 1s to 250ms. */
    fast_execution: boolean;
    take_profit?: number;
    stop_loss?: number;
    max_trades?: number;
    /** 2+ = burst mode: buy this many contracts all at once instead of one after another. */
    burst_count?: number;
    /** Burst slippage cap: stop sending once this many ticks have passed (default 3). */
    max_entry_ticks?: number;
    /** Higher/Lower and Touch/No Touch: distance of the barrier from the entry price (always positive; the sign comes from the contract). */
    barrier_offset?: number;
    /** Multipliers only: the multiplier (x). Blank = pick automatically from what Deriv offers for the market. */
    mult_value?: number;
};

export type TStrategyStatus = {
    id: string;
    client_id: string;
    label: string;
    symbol: string;
    contract_type: TBulkContractType;
    status: 'idle' | 'running' | 'stopped' | 'error';
    trades: number;
    wins: number;
    losses: number;
    total_profit: number;
    current_stake: number;
    last_result?: 'win' | 'loss';
    last_payout?: number;
    stop_reason?: string;
    error?: string;
};

export type TRunStatus = {
    run_id: string;
    loginid: string;
    is_active: boolean;
    strategies: TStrategyStatus[];
    started_at: string;
};

export type TStartBulkRunResponse = {
    run_id: string;
    strategies: { client_id: string; id: string }[];
};
