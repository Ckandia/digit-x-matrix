import { SPEC_ORDER, SWITCH_PARTNER } from './contractSpecs';
import { TBulkContractType, TMoneyManagement, TStrategyConfig } from './types';

export const BULK_TRADER_MAX_STRATEGIES = 5;

/** The app trades 1-second volatility indices only (Deriv symbols 1HZ10V ... 1HZ100V). */
export const isOneSecondSymbol = (symbol: string): boolean => /^1HZ\d+V$/.test(symbol);

export const SYMBOL_OPTIONS: { value: string; label: string }[] = [
    { value: '1HZ10V', label: 'Volatility 10 (1s) Index' },
    { value: '1HZ15V', label: 'Volatility 15 (1s) Index' },
    { value: '1HZ25V', label: 'Volatility 25 (1s) Index' },
    { value: '1HZ30V', label: 'Volatility 30 (1s) Index' },
    { value: '1HZ50V', label: 'Volatility 50 (1s) Index' },
    { value: '1HZ75V', label: 'Volatility 75 (1s) Index' },
    { value: '1HZ90V', label: 'Volatility 90 (1s) Index' },
    { value: '1HZ100V', label: 'Volatility 100 (1s) Index' },
];

export const CONTRACT_TYPE_OPTIONS: { value: TBulkContractType; label: string; needs_prediction: boolean; group: string }[] =
    SPEC_ORDER.map(spec => ({
        value: spec.key,
        label: spec.label,
        needs_prediction: spec.needs_prediction,
        group: spec.group,
    }));

export const CONTRACT_TYPE_LABELS: Record<TBulkContractType, string> = CONTRACT_TYPE_OPTIONS.reduce(
    (acc, opt) => ({ ...acc, [opt.value]: opt.label }),
    {} as Record<TBulkContractType, string>
);

export const MONEY_MANAGEMENT_OPTIONS: { value: TMoneyManagement; label: string }[] = [
    { value: 'flat', label: 'Flat stake' },
    { value: 'martingale', label: 'Martingale (multiply stake after a loss)' },
    { value: 'dalembert', label: "D'Alembert (step stake after a loss/win)" },
];

// The partner each contract switches with (Auto Flip) and runs alongside in "Both Sides" mode:
// Even<->Over 4, Odd<->Under 5, Touch<->Under 5, No Touch<->Over 4, Rise<->Under 5, Fall<->Over 4,
// Higher<->Under 5, Lower<->Over 4. Over/Under with a chosen digit keep their plain opposite here.
// Matches/Differs have no natural opposite (it depends on the predicted digit), so they fall back to a
// single "Start bulk run" button.
export const FLIP_PAIR: Partial<Record<TBulkContractType, TBulkContractType>> = {
    ...SWITCH_PARTNER,
    DIGITOVER: 'DIGITUNDER',
    DIGITUNDER: 'DIGITOVER',
};

export const DEFAULT_STRATEGY: Omit<TStrategyConfig, 'client_id'> = {
    label: 'Strategy 1',
    symbol: '1HZ10V',
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
