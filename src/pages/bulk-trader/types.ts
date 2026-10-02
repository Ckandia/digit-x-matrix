export type TDigitContractType = 'DIGITMATCH' | 'DIGITDIFF' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITEVEN' | 'DIGITODD';

export type TMoneyManagement = 'flat' | 'martingale' | 'dalembert';

export type TStrategyConfig = {
    /** Client-side only id (uuid) used before the backend assigns its own. */
    client_id: string;
    label: string;
    symbol: string;
    contract_type: TDigitContractType;
    /** Predicted digit (0-9). Required for DIGITMATCH / DIGITDIFF / DIGITOVER / DIGITUNDER. */
    prediction: number;
    stake: number;
    /** Contract duration in ticks (Deriv digit contracts are duration_unit: 't'). */
    duration_ticks: number;
    money_management: TMoneyManagement;
    /** Multiplier applied to stake after a loss (martingale) or step size (d'alembert). */
    multiplier: number;
    /** Switches Even<->Odd after a loss. Only meaningful for those two contract types. */
    auto_flip: boolean;
    /** Shortens the pause between trades from 1s to 250ms. */
    fast_execution: boolean;
    take_profit?: number;
    stop_loss?: number;
    max_trades?: number;
};

export type TStrategyStatus = {
    id: string;
    client_id: string;
    label: string;
    symbol: string;
    contract_type: TDigitContractType;
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
