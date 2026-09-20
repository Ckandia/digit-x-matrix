import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { localize } from '@deriv-com/translations';
import { useApiBase } from '@/hooks/useApiBase';
import { getBulkRunStatus, startBulkRun, stopBulkRun, BulkTraderApiError } from './api';
import {
    BULK_TRADER_MAX_STRATEGIES,
    CONTRACT_TYPE_LABELS,
    CONTRACT_TYPE_OPTIONS,
    DEFAULT_STRATEGY,
    FLIP_PAIR,
    MONEY_MANAGEMENT_OPTIONS,
    SYMBOL_OPTIONS,
} from './constants';
import { TDigitSignal } from './analysis-types';
import { TRunStatus, TStrategyConfig } from './types';
import { useDigitSignals } from './useDigitSignals';
import './bulk-trader.scss';

const STORAGE_KEY = 'bulk_trader_run_id';
const POLL_INTERVAL_MS = 3000;

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

// The app's OAuth2 login flow (Ory-issued tokens, prefixed "ory_at_") stores
// the active session's access token as JSON in localStorage.auth_info —
// confirmed by inspecting actual browser storage. The older accountsList /
// ClientStore.getToken() map is not populated by this flow.
const getActiveToken = (): string => {
    try {
        const raw = localStorage.getItem('auth_info');
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        return parsed?.access_token ?? '';
    } catch {
        return '';
    }
};

// --- Digit percentage grid (the 0-9 boxes) -------------------------------

const DigitGrid = ({
    percentages,
    hotDigit,
    coldDigit,
    highlightedDigit,
}: {
    percentages: number[];
    hotDigit: number;
    coldDigit: number;
    highlightedDigit?: number;
}) => (
    <div className='bulk-trader__digit-grid'>
        {Array.from({ length: 10 }, (_, digit) => {
            const pct = percentages[digit] ?? 0;
            const is_hot = digit === hotDigit;
            const is_cold = digit === coldDigit;
            const is_highlighted = digit === highlightedDigit;
            return (
                <div
                    key={digit}
                    className={[
                        'bulk-trader__digit-cell',
                        is_hot && 'bulk-trader__digit-cell--hot',
                        is_cold && 'bulk-trader__digit-cell--cold',
                        is_highlighted && 'bulk-trader__digit-cell--highlight',
                    ]
                        .filter(Boolean)
                        .join(' ')}
                >
                    <span className='bulk-trader__digit-value'>{digit}</span>
                    <span className='bulk-trader__digit-pct'>{pct.toFixed(2)}%</span>
                </div>
            );
        })}
    </div>
);

// --- Recent-tick history matrix (Even/Odd coloured grid) -----------------

const HistoryMatrix = ({ digits }: { digits: number[] }) => {
    const cells = digits.slice(-40);
    return (
        <div className='bulk-trader__history-matrix'>
            {cells.map((digit, index) => {
                const is_even = digit % 2 === 0;
                return (
                    <span
                        key={index}
                        className={`bulk-trader__history-cell ${is_even ? 'bulk-trader__history-cell--even' : 'bulk-trader__history-cell--odd'}`}
                        title={String(digit)}
                    >
                        {is_even ? 'E' : 'O'}
                    </span>
                );
            })}
            {cells.length === 0 && (
                <span className='bulk-trader__history-empty'>{localize('Waiting for ticks…')}</span>
            )}
        </div>
    );
};

// --- Live AI signal banner -------------------------------------------------

const SignalBanner = ({
    signal,
    totalTicks,
    onEnter,
}: {
    signal: TDigitSignal | undefined;
    totalTicks: number;
    onEnter: (signal: TDigitSignal) => void;
}) => {
    if (!signal) {
        return (
            <div className='bulk-trader__signal bulk-trader__signal--empty'>
                {totalTicks > 0
                    ? localize('Collecting ticks — no statistically significant signal yet.')
                    : localize('Connecting to the live digit feed…')}
            </div>
        );
    }
    return (
        <div className='bulk-trader__signal'>
            <div className='bulk-trader__signal-info'>
                <span className='bulk-trader__signal-tag'>{localize('SIGNAL')}</span>
                <div className='bulk-trader__signal-label'>{signal.label}</div>
                <div className='bulk-trader__signal-basis'>
                    {signal.basis} · {localize('confidence')} {signal.confidence}%
                </div>
            </div>
            <button type='button' className='bulk-trader__signal-enter' onClick={() => onEnter(signal)}>
                {localize('ENTER NOW')}
            </button>
        </div>
    );
};

const newStrategy = (overrides: Partial<TStrategyConfig> = {}): TStrategyConfig => ({
    ...DEFAULT_STRATEGY,
    client_id: makeId(),
    ...overrides,
});

const BulkTrader = () => {
    const { isAuthorized, activeLoginid } = useApiBase();
    const { snapshots, connectionState } = useDigitSignals();

    const [symbol, setSymbol] = useState(DEFAULT_STRATEGY.symbol);
    const [contractType, setContractType] = useState<TStrategyConfig['contract_type']>(DEFAULT_STRATEGY.contract_type);
    const [prediction, setPrediction] = useState(DEFAULT_STRATEGY.prediction);
    const [stake, setStake] = useState(DEFAULT_STRATEGY.stake);
    const [durationTicks, setDurationTicks] = useState(DEFAULT_STRATEGY.duration_ticks);
    const [maxTrades, setMaxTrades] = useState(DEFAULT_STRATEGY.max_trades ?? 10);
    const [moneyManagement, setMoneyManagement] = useState(DEFAULT_STRATEGY.money_management);
    const [multiplier, setMultiplier] = useState(DEFAULT_STRATEGY.multiplier);
    const [takeProfit, setTakeProfit] = useState(DEFAULT_STRATEGY.take_profit);
    const [stopLoss, setStopLoss] = useState(DEFAULT_STRATEGY.stop_loss);
    const [autoFlip, setAutoFlip] = useState(DEFAULT_STRATEGY.auto_flip);
    const [stopWin, setStopWin] = useState(true);
    const [bothSides, setBothSides] = useState(false);
    const [fastExecution, setFastExecution] = useState(DEFAULT_STRATEGY.fast_execution);
    const [showAdvanced, setShowAdvanced] = useState(false);

    const [runStatus, setRunStatus] = useState<TRunStatus | null>(null);
    const [runId, setRunId] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
    const [hasAcceptedRisk, setHasAcceptedRisk] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    const backend_configured = Boolean(process.env.NEXT_PUBLIC_BULK_TRADER_API_URL);
    const is_running = Boolean(runStatus?.is_active);

    // Reasons the start buttons are currently disabled, in priority order —
    // shown to the user instead of leaving them to guess at a plain
    // not-allowed cursor.
    const start_disabled_reasons: string[] = [];
    if (!isAuthorized) start_disabled_reasons.push(localize('log in to your Deriv account'));
    if (!backend_configured) start_disabled_reasons.push(localize('the Bulk Trader backend is not configured for this deployment'));
    if (!hasAcceptedRisk) start_disabled_reasons.push(localize('tick the risk checkbox above'));
    const start_disabled = isStarting;
    const start_not_ready = start_disabled_reasons.length > 0;
    const start_disabled_title = start_not_ready ? start_disabled_reasons.join(', ') : undefined;
    const [riskHighlight, setRiskHighlight] = useState(false);
    const riskCheckboxRef = useRef<HTMLInputElement>(null);

    const focusRiskCheck = () => {
        riskCheckboxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        riskCheckboxRef.current?.focus();
        setRiskHighlight(true);
        window.setTimeout(() => setRiskHighlight(false), 1800);
    };

    const guardedStart = (override_contract_type?: TStrategyConfig['contract_type']) => {
        if (start_not_ready) {
            setError(start_disabled_reasons.join(', '));
            if (!hasAcceptedRisk) focusRiskCheck();
            return;
        }
        handleStart(override_contract_type);
    };

    const contract_meta = CONTRACT_TYPE_OPTIONS.find(c => c.value === contractType);
    const snapshot = snapshots[symbol];
    const stats = snapshot?.stats;
    const signals = snapshot?.signals ?? [];
    const opposite_type = FLIP_PAIR[contractType];
    // Only surface a signal for the strategy currently selected — if you're
    // set up to trade Even/Odd, the signal shown (and the "ENTER NOW" /
    // glow) should be about Even or Odd, not whichever contract type
    // happens to have the strongest reading right now. When "Both Sides" is
    // on, either side of the pair counts as relevant.
    const relevant_contract_types = bothSides && opposite_type ? [contractType, opposite_type] : [contractType];
    const topSignal = signals.find(s => relevant_contract_types.includes(s.contract_type));

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const pollStatus = useCallback(
        async (id: string) => {
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
        },
        [stopPolling]
    );

    useEffect(() => {
        if (runId) {
            pollStatus(runId);
            pollRef.current = setInterval(() => pollStatus(runId), POLL_INTERVAL_MS);
        }
        return () => stopPolling();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runId]);

    // Workaround: this panel can grow taller than the viewport (e.g. when a
    // strategy adds the DIGIT field, or the run table appears), and some
    // ancestor in the surrounding tab shell clips overflow instead of
    // scrolling, making the lower part of the panel unreachable. Rather than
    // depend on that shell being fixed, walk up from this panel on mount and
    // temporarily relax any ancestor that's clipping, restoring its original
    // styles when this tab is left so other tabs are unaffected.
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;

        const touched: { el: HTMLElement; overflow: string; overflowY: string; maxHeight: string; height: string }[] = [];
        let el: HTMLElement | null = root.parentElement;
        while (el && el !== document.body) {
            const computed = window.getComputedStyle(el);
            const clips =
                computed.overflowY === 'hidden' ||
                computed.overflow === 'hidden' ||
                computed.overflow === 'clip';
            if (clips) {
                touched.push({
                    el,
                    overflow: el.style.overflow,
                    overflowY: el.style.overflowY,
                    maxHeight: el.style.maxHeight,
                    height: el.style.height,
                });
                el.style.overflowY = 'auto';
                el.style.maxHeight = 'none';
            }
            el = el.parentElement;
        }

        return () => {
            touched.forEach(({ el, overflow, overflowY, maxHeight, height }) => {
                el.style.overflow = overflow;
                el.style.overflowY = overflowY;
                el.style.maxHeight = maxHeight;
                el.style.height = height;
            });
        };
    }, []);

    const buildStrategyConfigs = useCallback(
        (override_contract_type?: TStrategyConfig['contract_type']): TStrategyConfig[] => {
            const base: Omit<TStrategyConfig, 'client_id' | 'label' | 'contract_type'> = {
                symbol,
                prediction,
                stake,
                duration_ticks: durationTicks,
                money_management: moneyManagement,
                multiplier,
                auto_flip: autoFlip,
                fast_execution: fastExecution,
                take_profit: stopWin ? takeProfit : undefined,
                stop_loss: stopLoss,
                max_trades: maxTrades,
            };
            const primary_type = override_contract_type ?? contractType;

            if (bothSides && FLIP_PAIR[primary_type]) {
                const secondary_type = FLIP_PAIR[primary_type] as TStrategyConfig['contract_type'];
                return [
                    newStrategy({ ...base, contract_type: primary_type, label: CONTRACT_TYPE_LABELS[primary_type] }),
                    newStrategy({ ...base, contract_type: secondary_type, label: CONTRACT_TYPE_LABELS[secondary_type] }),
                ];
            }
            return [newStrategy({ ...base, contract_type: primary_type, label: CONTRACT_TYPE_LABELS[primary_type] })];
        },
        [
            symbol,
            prediction,
            stake,
            durationTicks,
            moneyManagement,
            multiplier,
            autoFlip,
            fastExecution,
            stopWin,
            takeProfit,
            stopLoss,
            maxTrades,
            contractType,
            bothSides,
        ]
    );

    const handleStart = async (override_contract_type?: TStrategyConfig['contract_type']) => {
        setError(null);
        if (!hasAcceptedRisk) {
            setError(localize('Please confirm you understand the risk before starting a bulk run.'));
            return;
        }
        const token = getActiveToken();
        if (!token) {
            setError(localize('No active session token found. Please log in again.'));
            return;
        }
        const strategies = buildStrategyConfigs(override_contract_type);
        if (strategies.length > BULK_TRADER_MAX_STRATEGIES) {
            setError(localize('Too many strategies for one run.'));
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

    const applySignal = (signal: TDigitSignal) => {
        setContractType(signal.contract_type);
        if (typeof signal.prediction === 'number') setPrediction(signal.prediction);
    };

    const status_label = is_running ? localize('Running') : localize('Idle');
    const connection_label = useMemo(() => {
        if (connectionState === 'open') return localize('Live');
        if (connectionState === 'connecting') return localize('Connecting…');
        if (connectionState === 'unconfigured') return localize('Analysis feed not configured');
        return localize('Reconnecting…');
    }, [connectionState]);

    // Whether the live AI signal currently agrees with the primary /
    // opposite-side action button, so we can give the matching button a
    // "ready to press" glow instead of only glowing the signal banner.
    const primary_matches_signal = Boolean(topSignal && topSignal.contract_type === contractType);
    const opposite_matches_signal = Boolean(topSignal && opposite_type && topSignal.contract_type === opposite_type);

    return (
        <div className='bulk-trader' ref={rootRef}>
            <div className='bulk-trader__intro'>
                <h3>{localize('Bulk Trades')}</h3>
                <p>
                    {localize(
                        'The backend analyses live digit ticks and surfaces a statistical signal here. You choose whether to act on it — nothing trades until you start a run.'
                    )}
                </p>
            </div>

            {!backend_configured && (
                <div className='bulk-trader__notice bulk-trader__notice--warning'>
                    {localize(
                        'The backend is not configured yet. Set NEXT_PUBLIC_BULK_TRADER_API_URL to your deployed Render backend URL.'
                    )}
                </div>
            )}

            {!isAuthorized && (
                <div className='bulk-trader__notice'>{localize('Log in to your Deriv account to use Bulk Trades.')}</div>
            )}

            {error && <div className='bulk-trader__notice bulk-trader__notice--error'>{error}</div>}

            <div className='bulk-trader__status-bar'>
                <span className={`bulk-trader__dot bulk-trader__dot--${isAuthorized ? 'on' : 'off'}`} />
                {isAuthorized ? (
                    <span>
                        {localize('Connected')} — <strong>{activeLoginid}</strong>
                    </span>
                ) : (
                    <span>{localize('Not connected')}</span>
                )}
                <span className='bulk-trader__status-bar-divider' />
                <span className={`bulk-trader__feed-dot bulk-trader__feed-dot--${connectionState}`} />
                <span>{connection_label}</span>
            </div>

            <SignalBanner signal={topSignal} totalTicks={stats?.total_ticks ?? 0} onEnter={applySignal} />

            <div className='bulk-trader__console'>
                <div className='bulk-trader__panel'>
                    <div className='bulk-trader__field-row'>
                        <label className='bulk-trader__field'>
                            <span>{localize('MARKET')}</span>
                            <select value={symbol} onChange={e => setSymbol(e.target.value)} disabled={is_running}>
                                {SYMBOL_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className='bulk-trader__field'>
                            <span>{localize('STRATEGY')}</span>
                            <select
                                value={contractType}
                                onChange={e => setContractType(e.target.value as TStrategyConfig['contract_type'])}
                                disabled={is_running}
                            >
                                {CONTRACT_TYPE_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>

                    {contract_meta?.needs_prediction && (
                        <label className='bulk-trader__field'>
                            <span>{localize('DIGIT')}</span>
                            <select
                                value={prediction}
                                onChange={e => setPrediction(Number(e.target.value))}
                                disabled={is_running}
                            >
                                {Array.from({ length: 10 }, (_, d) => d).map(d => (
                                    <option key={d} value={d}>
                                        {d}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}

                    <label className='bulk-trader__field'>
                        <span>{localize('STAKE (USD)')}</span>
                        <input
                            type='number'
                            min={0.35}
                            step={0.01}
                            value={stake}
                            onChange={e => setStake(Number(e.target.value))}
                            disabled={is_running}
                        />
                    </label>

                    <div className='bulk-trader__field-row'>
                        <label className='bulk-trader__field'>
                            <span>{localize('DURATION (TICKS)')}</span>
                            <input
                                type='number'
                                min={1}
                                step={1}
                                value={durationTicks}
                                onChange={e => setDurationTicks(Number(e.target.value))}
                                disabled={is_running}
                            />
                        </label>

                        <label className='bulk-trader__field'>
                            <span>{localize('NO. OF BULK TRADES')}</span>
                            <input
                                type='number'
                                min={1}
                                step={1}
                                value={maxTrades}
                                onChange={e => setMaxTrades(Number(e.target.value))}
                                disabled={is_running}
                            />
                        </label>
                    </div>

                    <div className='bulk-trader__toggle-row'>
                        <label className='bulk-trader__toggle'>
                            <input
                                type='checkbox'
                                checked={autoFlip}
                                onChange={e => setAutoFlip(e.target.checked)}
                                disabled={is_running}
                            />
                            <span className='bulk-trader__toggle-track' />
                            <span className='bulk-trader__toggle-label'>
                                {localize('Auto Flip')}
                                <em title={localize('Switches Even/Odd (or Over/Under) after a loss.')}>i</em>
                            </span>
                        </label>

                        <label className='bulk-trader__toggle'>
                            <input
                                type='checkbox'
                                checked={stopWin}
                                onChange={e => setStopWin(e.target.checked)}
                                disabled={is_running}
                            />
                            <span className='bulk-trader__toggle-track' />
                            <span className='bulk-trader__toggle-label'>
                                {localize('Stop Win')}
                                <em title={localize('Stops the run once the take-profit target below is reached.')}>i</em>
                            </span>
                        </label>

                        <label className='bulk-trader__toggle'>
                            <input
                                type='checkbox'
                                checked={bothSides}
                                onChange={e => setBothSides(e.target.checked)}
                                disabled={is_running || !opposite_type}
                            />
                            <span className='bulk-trader__toggle-track' />
                            <span className='bulk-trader__toggle-label'>
                                {localize('Both Sides')}
                                <em title={localize('Runs this strategy and its opposite side at the same time.')}>i</em>
                            </span>
                        </label>
                    </div>

                    <button
                        type='button'
                        className='bulk-trader__advanced-toggle'
                        onClick={() => setShowAdvanced(v => !v)}
                    >
                        {showAdvanced ? localize('Hide advanced settings') : localize('Advanced settings')}
                    </button>

                    {showAdvanced && (
                        <div className='bulk-trader__advanced'>
                            <label className='bulk-trader__field'>
                                <span>{localize('Money management')}</span>
                                <select
                                    value={moneyManagement}
                                    onChange={e => setMoneyManagement(e.target.value as TStrategyConfig['money_management'])}
                                    disabled={is_running}
                                >
                                    {MONEY_MANAGEMENT_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            {moneyManagement !== 'flat' && (
                                <label className='bulk-trader__field'>
                                    <span>{localize('Multiplier')}</span>
                                    <input
                                        type='number'
                                        min={1.01}
                                        step={0.1}
                                        value={multiplier}
                                        onChange={e => setMultiplier(Number(e.target.value))}
                                        disabled={is_running}
                                    />
                                </label>
                            )}

                            <label className='bulk-trader__field'>
                                <span>{localize('Take profit (USD)')}</span>
                                <input
                                    type='number'
                                    min={0}
                                    step={0.01}
                                    value={takeProfit ?? ''}
                                    onChange={e => setTakeProfit(e.target.value ? Number(e.target.value) : undefined)}
                                    disabled={is_running || !stopWin}
                                />
                            </label>

                            <label className='bulk-trader__field'>
                                <span>{localize('Stop loss (USD)')}</span>
                                <input
                                    type='number'
                                    min={0}
                                    step={0.01}
                                    value={stopLoss ?? ''}
                                    onChange={e => setStopLoss(e.target.value ? Number(e.target.value) : undefined)}
                                    disabled={is_running}
                                />
                            </label>
                        </div>
                    )}
                </div>

                <div className='bulk-trader__panel bulk-trader__panel--matrix'>
                    <DigitGrid
                        percentages={stats?.digit_percentages ?? new Array(10).fill(0)}
                        hotDigit={stats?.hot_digit ?? -1}
                        coldDigit={stats?.cold_digit ?? -1}
                        highlightedDigit={contract_meta?.needs_prediction ? prediction : undefined}
                    />
                    <HistoryMatrix digits={stats?.last_digits ?? []} />
                </div>
            </div>

            {!is_running && (
                <>
                    <label
                        className={[
                            'bulk-trader__risk-check',
                            riskHighlight && 'bulk-trader__risk-check--highlight',
                        ]
                            .filter(Boolean)
                            .join(' ')}
                    >
                        <input
                            ref={riskCheckboxRef}
                            type='checkbox'
                            checked={hasAcceptedRisk}
                            onChange={e => setHasAcceptedRisk(e.target.checked)}
                        />
                        {localize(
                            'I understand this will place real trades automatically on my account and I could lose some or all of my stake.'
                        )}
                    </label>

                    <div className='bulk-trader__action-row'>
                        {opposite_type ? (
                            <>
                                <button
                                    type='button'
                                    className={[
                                        'bulk-trader__action-btn',
                                        'bulk-trader__action-btn--positive',
                                        primary_matches_signal && 'bulk-trader__action-btn--signal-match',
                                        start_not_ready && 'bulk-trader__action-btn--not-ready',
                                    ]
                                        .filter(Boolean)
                                        .join(' ')}
                                    disabled={start_disabled}
                                    title={start_disabled_title}
                                    onClick={() => guardedStart(contractType)}
                                >
                                    {isStarting ? localize('Starting…') : `${localize('Bulk')} ${CONTRACT_TYPE_LABELS[contractType]}`}
                                </button>

                                <button
                                    type='button'
                                    className='bulk-trader__action-btn bulk-trader__action-btn--ai'
                                    disabled={!topSignal}
                                    onClick={() => topSignal && applySignal(topSignal)}
                                    title={localize('Apply the current AI signal to the form above')}
                                >
                                    {localize('AI')}: {topSignal ? topSignal.label : localize('—')}
                                </button>

                                <button
                                    type='button'
                                    className={[
                                        'bulk-trader__action-btn',
                                        'bulk-trader__action-btn--negative',
                                        opposite_matches_signal && 'bulk-trader__action-btn--signal-match',
                                        start_not_ready && 'bulk-trader__action-btn--not-ready',
                                    ]
                                        .filter(Boolean)
                                        .join(' ')}
                                    disabled={start_disabled}
                                    title={start_disabled_title}
                                    onClick={() => guardedStart(opposite_type)}
                                >
                                    {isStarting
                                        ? localize('Starting…')
                                        : `${localize('Bulk')} ${CONTRACT_TYPE_LABELS[opposite_type]}`}
                                </button>
                            </>
                        ) : (
                            <button
                                type='button'
                                className={[
                                    'bulk-trader__action-btn',
                                    'bulk-trader__action-btn--positive',
                                    'bulk-trader__action-btn--wide',
                                    primary_matches_signal && 'bulk-trader__action-btn--signal-match',
                                    start_not_ready && 'bulk-trader__action-btn--not-ready',
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                                disabled={start_disabled}
                                title={start_disabled_title}
                                onClick={() => guardedStart()}
                            >
                                {isStarting ? localize('Starting…') : localize('Start bulk run')}
                            </button>
                        )}
                    </div>

                    {start_disabled_reasons.length > 0 && (
                        <div className='bulk-trader__disabled-hint'>
                            {localize('Can\'t start yet — ')}
                            {start_disabled_reasons.join(localize(' · '))}
                        </div>
                    )}
                </>
            )}

            <div className='bulk-trader__footer-row'>
                <span className={`bulk-trader__status-pill bulk-trader__status-pill--${is_running ? 'running' : 'idle'}`}>
                    {status_label}
                </span>
                <label className='bulk-trader__toggle bulk-trader__toggle--inline'>
                    <input
                        type='checkbox'
                        checked={fastExecution}
                        onChange={e => setFastExecution(e.target.checked)}
                        disabled={is_running}
                    />
                    <span className='bulk-trader__toggle-track' />
                    <span className='bulk-trader__toggle-label'>{localize('Execution FAST')}</span>
                </label>
            </div>

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
