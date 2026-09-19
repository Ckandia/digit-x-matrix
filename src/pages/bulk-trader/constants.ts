import { TDigitContractType, TMoneyManagement, TStrategyConfig } from './types';

export const BULK_TRADER_MAX_STRATEGIES = 5;

export const SYMBOL_OPTIONS: { value: string; label: string }[] = [
    { value: 'R_10', label: 'Volatility 10 Index' },
    { value: '1HZ10V', label: 'Volatility 10 (1s) Index' },
    { value: '1HZ15V', label: 'Volatility 15 (1s) Index' },
    { value: 'R_25', label: 'Volatility 25 Index' },
    { value: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { value: '1HZ30V', label: 'Volatility 30 (1s) Index' },
    { value: 'R_50', label: 'Volatility 50 Index' },
    { value: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { value: 'R_75', label: 'Volatility 75 Index' },
    { value: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { value: 'R_100', label: 'Volatility 100 Index' },
    { value: '1HZ90V', label: 'Volatility 90 (1s) Index' },
    { value: '1HZ100V', label: 'Volatility 100 (1s) Index' },
    { value: 'JD10', label: 'Jump 10 Index' },
    { value: 'JD25', label: 'Jump 25 Index' },
    { value: 'JD50', label: 'Jump 50 Index' },
    { value: 'JD75', label: 'Jump 75 Index' },
    { value: 'JD100', label: 'Jump 100 Index' },
];

export const CONTRACT_TYPE_OPTIONS: { value: TDigitContractType; label: string; needs_prediction: boolean }[] = [
    { value: 'DIGITDIFF', label: 'Differs', needs_prediction: true },
    { value: 'DIGITMATCH', label: 'Matches', needs_prediction: true },
    { value: 'DIGITOVER', label: 'Over', needs_prediction: true },
    { value: 'DIGITUNDER', label: 'Under', needs_prediction: true },
    { value: 'DIGITEVEN', label: 'Even', needs_prediction: false },
    { value: 'DIGITODD', label: 'Odd', needs_prediction: false },
];

export const CONTRACT_TYPE_LABELS: Record<TDigitContractType, string> = CONTRACT_TYPE_OPTIONS.reduce(
    (acc, opt) => ({ ...acc, [opt.value]: opt.label }),
    {} as Record<TDigitContractType, string>
);

export const MONEY_MANAGEMENT_OPTIONS: { value: TMoneyManagement; label: string }[] = [
    { value: 'flat', label: 'Flat stake' },
    { value: 'martingale', label: 'Martingale (multiply stake after a loss)' },
    { value: 'dalembert', label: "D'Alembert (step stake after a loss/win)" },
];

// The two-sided contract families the quick "Bulk <X> / AI / Bulk <Y>" action
// row understands. Matches/Differs aren't a natural opposite pair (the
// counterpart depends on the predicted digit, not just the contract type), so
// they fall back to a single "Start bulk run" button instead of this row.
export const FLIP_PAIR: Partial<Record<TDigitContractType, TDigitContractType>> = {
    DIGITEVEN: 'DIGITODD',
    DIGITODD: 'DIGITEVEN',
    DIGITOVER: 'DIGITUNDER',
    DIGITUNDER: 'DIGITOVER',
};

export const DEFAULT_STRATEGY: Omit<TStrategyConfig, 'client_id'> = {
    label: 'Strategy 1',
    symbol: 'R_10',
    contract_type: 'DIGITEVEN',
    prediction: 5,
    stake: 1,
    duration_ticks: 1,
    money_management: 'flat',
    multiplier: 2,
    auto_flip: false,
    fast_execution: true,
    take_profit: 10,
    stop_loss: 10,
    max_trades: 10,
};
