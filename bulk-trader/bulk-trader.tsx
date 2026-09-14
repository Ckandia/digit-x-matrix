import React, { useCallback, useEffect, useRef, useState } from 'react';
import { localize } from '@deriv-com/translations';
import { useApiBase } from '@/hooks/useApiBase';
import { getBulkRunStatus, startBulkRun, stopBulkRun, BulkTraderApiError } from './api';
import { BULK_TRADER_MAX_STRATEGIES, CONTRACT_TYPE_OPTIONS, DEFAULT_STRATEGY, MONEY_MANAGEMENT_OPTIONS, SYMBOL_OPTIONS } from './constants';
import { TRunStatus, TStrategyConfig } from './types';
import './bulk-trader.scss';

const STORAGE_KEY = 'bulk_trader_run_id';
const POLL_INTERVAL_MS = 3000;

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const getActiveToken = (): string | null => {
    try {
        const direct = localStorage.getItem('authToken');
        if (direct) return direct;
        const login_id = localStorage.getItem('active_loginid');
        const accounts_list = localStorage.getItem('accountsList');
        if (login_id && accounts_list) {
            const parsed = JSON.parse(accounts_list);
            if (parsed?.[login_id]) return String(parsed[login_id]);
        }
    } catch {
        // ignore malformed localStorage content
    }
    return null;
};

const newStrategy = (index: number): TStrategyConfig => ({
    ...DEFAULT_STRATEGY,
    client_id: makeId(),
    label: `Strategy ${index}`,
});

const BulkTrader = () => {
    const { isAuthorized, activeLoginid } = useApiBase();
    const [strategies, setStrategies] = useState<TStrategyConfig[]>([newStrategy(1)]);
    const [runStatus, setRunStatus] = useState<TRunStatus | null>(null);
    const [runId, setRunId] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
    const [hasAcceptedRisk, setHasAcceptedRisk] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const backend_configured = Boolean(process.env.NEXT_PUBLIC_BULK_TRADER_API_URL);
    const is_running = Boolean(runStatus?.is_active);

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const pollStatus = useCallback(async (id: string) => {
        try {
            const status = await getBulkRunStatus(id);
            setRunStatus(status);
            if (!status.is_active) {
                stopPolling();
            }
        } catch (err) {
            setError(err instanceof BulkTraderApiError ? err.message : localize('Could not reach the Bulk Trader backend.'));
            stopPolling();
        }
    }, [stopPolling]);

    useEffect(() => {
        if (runId) {
            pollStatus(runId);
            pollRef.current = setInterval(() => pollStatus(runId), POLL_INTERVAL_MS);
        }
        return () => stopPolling();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runId]);

    const updateStrategy = (client_id: string, patch: Partial<TStrategyConfig>) => {
        setStrategies(prev => prev.map(s => (s.client_id === client_id ? { ...s, ...patch } : s)));
    };

    const addStrategy = () => {
        if (strategies.length >= BULK_TRADER_MAX_STRATEGIES) return;
        setStrategies(prev => [...prev, newStrategy(prev.length + 1)]);
    };

    const removeStrategy = (client_id: string) => {
        setStrategies(prev => (prev.length > 1 ? prev.filter(s => s.client_id !== client_id) : prev));
    };

    const handleStart = async () => {
        setError(null);
        const token = getActiveToken();
        if (!token) {
            setError(localize('No active session token found. Please log in again.'));
            return;
        }
        setIsStarting(true);
        try {
            const response = await startBulkRun(token, strategies);
            sessionStorage.setItem(STORAGE_KEY, response.run_id);
            setRunId(response.run_id);
        } catch (err) {
            setError(err instanceof BulkTraderApiError ? err.message : localize('Failed to start the bulk run.'));
        } finally {
            setIsStarting(false);
        }
    };

    const handleStopAll = async () => {
        if (!runId) return;
        try {
            await stopBulkRun(runId);
        } catch (err) {
            setError(err instanceof BulkTraderApiError ? err.message : localize('Failed to stop the bulk run.'));
        } finally {
            sessionStorage.removeItem(STORAGE_KEY);
            setRunId(null);
            stopPolling();
        }
    };

    const handleStopOne = async (strategy_id: string) => {
        if (!runId) return;
        try {
            await stopBulkRun(runId, strategy_id);
            pollStatus(runId);
        } catch (err) {
            setError(err instanceof BulkTraderApiError ? err.message : localize('Failed to stop that strategy.'));
        }
    };

    return (
        <div className='bulk-trader'>
            <div className='bulk-trader__intro'>
                <h3>{localize('Bulk Trader')}</h3>
                <p>
                    {localize(
                        'Run several digit-trading strategies at the same time on this account. Each strategy trades independently with its own stake, money management, and stop conditions.'
                    )}
                </p>
            </div>

            {!backend_configured && (
                <div className='bulk-trader__notice bulk-trader__notice--warning'>
                    {localize(
                        'The Bulk Trader backend is not configured yet. Set NEXT_PUBLIC_BULK_TRADER_API_URL to your deployed Render backend URL.'
                    )}
                </div>
            )}

            {!isAuthorized && (
                <div className='bulk-trader__notice'>{localize('Log in to your Deriv account to use Bulk Trader.')}</div>
            )}

            {error && <div className='bulk-trader__notice bulk-trader__notice--error'>{error}</div>}

            {!is_running && isAuthorized && (
                <>
                    <div className='bulk-trader__strategies'>
                        {strategies.map((strategy, index) => {
                            const contract_meta = CONTRACT_TYPE_OPTIONS.find(c => c.value === strategy.contract_type);
                            return (
                                <div className='bulk-trader__card' key={strategy.client_id}>
                                    <div className='bulk-trader__card-header'>
                                        <input
                                            className='bulk-trader__label-input'
                                            value={strategy.label}
                                            onChange={e => updateStrategy(strategy.client_id, { label: e.target.value })}
                                        />
                                        {strategies.length > 1 && (
                                            <button
                                                type='button'
                                                className='bulk-trader__remove-btn'
                                                onClick={() => removeStrategy(strategy.client_id)}
                                                aria-label={localize('Remove strategy')}
                                            >
                                                ×
                                            </button>
                                        )}
                                    </div>

                                    <div className='bulk-trader__grid'>
                                        <label>
                                            {localize('Symbol')}
                                            <select
                                                value={strategy.symbol}
                                                onChange={e => updateStrategy(strategy.client_id, { symbol: e.target.value })}
                                            >
                                                {SYMBOL_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>
                                                        {opt.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>

                                        <label>
                                            {localize('Contract type')}
                                            <select
                                                value={strategy.contract_type}
                                                onChange={e =>
                                                    updateStrategy(strategy.client_id, {
                                                        contract_type: e.target.value as TStrategyConfig['contract_type'],
                                                    })
                                                }
                                            >
                                                {CONTRACT_TYPE_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>
                                                        {opt.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>

                                        {contract_meta?.needs_prediction && (
                                            <label>
                                                {localize('Digit')}
                                                <select
                                                    value={strategy.prediction}
                                                    onChange={e =>
                                                        updateStrategy(strategy.client_id, {
                                                            prediction: Number(e.target.value),
                                                        })
                                                    }
                                                >
                                                    {Array.from({ length: 10 }, (_, d) => d).map(d => (
                                                        <option key={d} value={d}>
                                                            {d}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                        )}

                                        <label>
                                            {localize('Stake')}
                                            <input
                                                type='number'
                                                min={0.35}
                                                step={0.01}
                                                value={strategy.stake}
                                                onChange={e =>
                                                    updateStrategy(strategy.client_id, { stake: Number(e.target.value) })
                                                }
                                            />
                                        </label>

                                        <label>
                                            {localize('Money management')}
                                            <select
                                                value={strategy.money_management}
                                                onChange={e =>
                                                    updateStrategy(strategy.client_id, {
                                                        money_management: e.target.value as TStrategyConfig['money_management'],
                                                    })
                                                }
                                            >
                                                {MONEY_MANAGEMENT_OPTIONS.map(opt => (
                                                    <option key={opt.value} value={opt.value}>
                                                        {opt.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>

                                        {strategy.money_management !== 'flat' && (
                                            <label>
                                                {localize('Multiplier')}
                                                <input
                                                    type='number'
                                                    min={1.01}
                                                    step={0.1}
                                                    value={strategy.multiplier}
                                                    onChange={e =>
                                                        updateStrategy(strategy.client_id, {
                                                            multiplier: Number(e.target.value),
                                                        })
                                                    }
                                                />
                                            </label>
                                        )}

                                        <label>
                                            {localize('Take profit')}
                                            <input
                                                type='number'
                                                min={0}
                                                step={0.01}
                                                value={strategy.take_profit ?? ''}
                                                onChange={e =>
                                                    updateStrategy(strategy.client_id, {
                                                        take_profit: e.target.value ? Number(e.target.value) : undefined,
                                                    })
                                                }
                                            />
                                        </label>

                                        <label>
                                            {localize('Stop loss')}
                                            <input
                                                type='number'
                                                min={0}
                                                step={0.01}
                                                value={strategy.stop_loss ?? ''}
                                                onChange={e =>
                                                    updateStrategy(strategy.client_id, {
                                                        stop_loss: e.target.value ? Number(e.target.value) : undefined,
                                                    })
                                                }
                                            />
                                        </label>

                                        <label>
                                            {localize('Max trades')}
                                            <input
                                                type='number'
                                                min={1}
                                                step={1}
                                                value={strategy.max_trades ?? ''}
                                                onChange={e =>
                                                    updateStrategy(strategy.client_id, {
                                                        max_trades: e.target.value ? Number(e.target.value) : undefined,
                                                    })
                                                }
                                            />
                                        </label>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <button
                        type='button'
                        className='bulk-trader__add-btn'
                        onClick={addStrategy}
                        disabled={strategies.length >= BULK_TRADER_MAX_STRATEGIES}
                    >
                        + {localize('Add strategy')} ({strategies.length}/{BULK_TRADER_MAX_STRATEGIES})
                    </button>

                    <label className='bulk-trader__risk-check'>
                        <input
                            type='checkbox'
                            checked={hasAcceptedRisk}
                            onChange={e => setHasAcceptedRisk(e.target.checked)}
                        />
                        {localize(
                            'I understand these strategies will place real trades automatically on my account and I could lose some or all of my stake.'
                        )}
                    </label>

                    <button
                        type='button'
                        className='bulk-trader__start-btn'
                        disabled={!hasAcceptedRisk || isStarting || !backend_configured}
                        onClick={handleStart}
                    >
                        {isStarting ? localize('Starting...') : localize('Start bulk run')}
                    </button>
                </>
            )}

            {is_running && runStatus && (
                <div className='bulk-trader__run'>
                    <div className='bulk-trader__run-header'>
                        <span>
                            {localize('Running on account')} <strong>{activeLoginid}</strong>
                        </span>
                        <button type='button' className='bulk-trader__stop-all-btn' onClick={handleStopAll}>
                            {localize('Stop all')}
                        </button>
                    </div>

                    <table className='bulk-trader__table'>
                        <thead>
                            <tr>
                                <th>{localize('Strategy')}</th>
                                <th>{localize('Symbol')}</th>
                                <th>{localize('Status')}</th>
                                <th>{localize('Trades')}</th>
                                <th>{localize('W/L')}</th>
                                <th>{localize('P/L')}</th>
                                <th>{localize('Stake')}</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {runStatus.strategies.map(s => (
                                <tr key={s.id}>
                                    <td>{s.label}</td>
                                    <td>{s.symbol}</td>
                                    <td className={`bulk-trader__status bulk-trader__status--${s.status}`}>
                                        {s.status}
                                        {s.stop_reason ? ` (${s.stop_reason})` : ''}
                                    </td>
                                    <td>{s.trades}</td>
                                    <td>
                                        {s.wins}/{s.losses}
                                    </td>
                                    <td className={s.total_profit >= 0 ? 'bulk-trader__profit' : 'bulk-trader__loss'}>
                                        {s.total_profit.toFixed(2)}
                                    </td>
                                    <td>{s.current_stake.toFixed(2)}</td>
                                    <td>
                                        {s.status === 'running' && (
                                            <button
                                                type='button'
                                                className='bulk-trader__stop-one-btn'
                                                onClick={() => handleStopOne(s.id)}
                                            >
                                                {localize('Stop')}
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default BulkTrader;
