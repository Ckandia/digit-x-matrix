import React, { useEffect, useRef, useState } from 'react';
import { localize } from '@deriv-com/translations';
import { useApiBase } from '@/hooks/useApiBase';
import { getActiveToken } from './tokenStorage';
import { startAiRun, getAiRunStatus, stopAiRun, BulkTraderApiError } from './api';
import { TAiAgentConfig, TAiRunStatus } from './aiAgentTypes';
import { useAiAgentEvents } from './useAiAgentEvents';
import AiAgentPipeline from './AiAgentPipeline';
import { SYMBOL_OPTIONS } from './constants';
import './ai-agent-panel.scss';

const STORAGE_KEY = 'ai_agent_run_id';
const POLL_INTERVAL_MS = 3000;

// The agent only trades symbols the backend's digit engine actually analyzes
// (backend/src/marketFeed.js DIGIT_SYMBOLS) — offering the full Bulk Trader
// symbol list here would let someone pick a symbol the agent can never score,
// which would silently never trade rather than failing loudly.
const ANALYZED_SYMBOLS = new Set([
    'R_10',
    'R_25',
    'R_50',
    'R_75',
    'R_100',
    '1HZ10V',
    '1HZ25V',
    '1HZ50V',
    '1HZ75V',
    '1HZ100V',
]);
const AGENT_SYMBOL_OPTIONS = SYMBOL_OPTIONS.filter(o => ANALYZED_SYMBOLS.has(o.value));

const AiAgentPanel = ({
    hasAcceptedRisk,
    onNeedsRiskAccept,
}: {
    hasAcceptedRisk: boolean;
    onNeedsRiskAccept: () => void;
}) => {
    const { isAuthorized } = useApiBase();
    const { events, clear: clearEvents } = useAiAgentEvents();

    const [selectedSymbols, setSelectedSymbols] = useState<string[]>(AGENT_SYMBOL_OPTIONS.map(o => o.value));
    const [stake, setStake] = useState(1);
    const [minConfidence, setMinConfidence] = useState(65);
    const [stopLoss, setStopLoss] = useState(10);
    const [takeProfit, setTakeProfit] = useState<number | undefined>(20);
    const [maxTrades, setMaxTrades] = useState(30);

    const [runStatus, setRunStatus] = useState<TAiRunStatus | null>(null);
    const [runId, setRunId] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
    const [isStarting, setIsStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const backend_configured = Boolean(process.env.NEXT_PUBLIC_BULK_TRADER_API_URL);
    const is_running = runStatus?.agent.status === 'running';

    const stopPolling = () => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
    };

    const poll = (id: string) => {
        stopPolling();
        pollRef.current = setInterval(async () => {
            try {
                const status = await getAiRunStatus(id);
                setRunStatus(status);
                if (status.agent.status !== 'running') {
                    stopPolling();
                    sessionStorage.removeItem(STORAGE_KEY);
                    setRunId(null);
                }
            } catch {
                stopPolling();
                sessionStorage.removeItem(STORAGE_KEY);
                setRunId(null);
            }
        }, POLL_INTERVAL_MS);
    };

    useEffect(() => {
        if (runId) poll(runId);
        return () => stopPolling();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleSymbol = (value: string) => {
        setSelectedSymbols(prev => (prev.includes(value) ? prev.filter(s => s !== value) : [...prev, value]));
    };

    const handleStart = async () => {
        setError(null);
        if (!hasAcceptedRisk) {
            onNeedsRiskAccept();
            return;
        }
        const token = getActiveToken();
        if (!token) {
            setError(localize('Save a Deriv API token in the header above first.'));
            return;
        }
        if (selectedSymbols.length === 0) {
            setError(localize('Select at least one symbol for the agent to watch.'));
            return;
        }

        const config: TAiAgentConfig = {
            symbols: selectedSymbols,
            stake,
            min_confidence: minConfidence,
            stop_loss: stopLoss,
            take_profit: takeProfit,
            max_trades: maxTrades,
            duration_ticks: 1,
        };

        setIsStarting(true);
        clearEvents();
        try {
            const result = await startAiRun(token, config);
            sessionStorage.setItem(STORAGE_KEY, result.run_id);
            setRunId(result.run_id);
            poll(result.run_id);
        } catch (err) {
            setError(err instanceof BulkTraderApiError ? err.message : localize('Could not start the AI agent.'));
        } finally {
            setIsStarting(false);
        }
    };

    const handleStop = async () => {
        if (!runId) return;
        try {
            await stopAiRun(runId);
        } catch {
            // best-effort — polling will reflect the real state either way
        }
        stopPolling();
        sessionStorage.removeItem(STORAGE_KEY);
        setRunId(null);
    };

    const start_disabled_reasons: string[] = [];
    if (!isAuthorized) start_disabled_reasons.push(localize('log in to your Deriv account'));
    if (!backend_configured) start_disabled_reasons.push(localize('the backend is not configured for this deployment'));
    const start_disabled = isStarting || is_running;

    return (
        <section className='ai-agent-panel'>
            <header className='ai-agent-panel__header'>
                <h3>{localize('AI agent')}</h3>
                <p>
                    {localize(
                        'Watches every selected market, scores each digit contract by how far it has drifted from its statistical baseline, and only trades when that deviation clears your threshold. This is a deviation score, not a win-probability estimate — digit outcomes on these indices are independent draws, so past frequency does not change the odds of the next tick.'
                    )}
                </p>
            </header>

            {error && <div className='ai-agent-panel__error'>{error}</div>}

            <div className='ai-agent-panel__config'>
                <div className='ai-agent-panel__field ai-agent-panel__field--wide'>
                    <label>{localize('Symbols to watch')}</label>
                    <div className='ai-agent-panel__symbol-grid'>
                        {AGENT_SYMBOL_OPTIONS.map(opt => (
                            <label key={opt.value} className='ai-agent-panel__symbol-chip'>
                                <input
                                    type='checkbox'
                                    checked={selectedSymbols.includes(opt.value)}
                                    disabled={is_running}
                                    onChange={() => toggleSymbol(opt.value)}
                                />
                                {opt.label}
                            </label>
                        ))}
                    </div>
                </div>

                <div className='ai-agent-panel__field'>
                    <label htmlFor='ai-stake'>{localize('Stake per trade')}</label>
                    <input
                        id='ai-stake'
                        type='number'
                        min={0.35}
                        step={0.5}
                        value={stake}
                        disabled={is_running}
                        onChange={e => setStake(Number(e.target.value))}
                    />
                </div>

                <div className='ai-agent-panel__field'>
                    <label htmlFor='ai-confidence'>{localize('Minimum deviation score (40-100)')}</label>
                    <input
                        id='ai-confidence'
                        type='number'
                        min={40}
                        max={100}
                        value={minConfidence}
                        disabled={is_running}
                        onChange={e => setMinConfidence(Number(e.target.value))}
                    />
                </div>

                <div className='ai-agent-panel__field'>
                    <label htmlFor='ai-stop-loss'>{localize('Stop loss (required)')}</label>
                    <input
                        id='ai-stop-loss'
                        type='number'
                        min={0.35}
                        step={1}
                        value={stopLoss}
                        disabled={is_running}
                        onChange={e => setStopLoss(Number(e.target.value))}
                    />
                </div>

                <div className='ai-agent-panel__field'>
                    <label htmlFor='ai-take-profit'>{localize('Take profit (optional)')}</label>
                    <input
                        id='ai-take-profit'
                        type='number'
                        min={0}
                        step={1}
                        value={takeProfit ?? ''}
                        disabled={is_running}
                        onChange={e => setTakeProfit(e.target.value === '' ? undefined : Number(e.target.value))}
                    />
                </div>

                <div className='ai-agent-panel__field'>
                    <label htmlFor='ai-max-trades'>{localize('Max trades')}</label>
                    <input
                        id='ai-max-trades'
                        type='number'
                        min={1}
                        max={200}
                        value={maxTrades}
                        disabled={is_running}
                        onChange={e => setMaxTrades(Number(e.target.value))}
                    />
                </div>
            </div>

            <div className='ai-agent-panel__actions'>
                {!is_running ? (
                    <button
                        type='button'
                        className='ai-agent-panel__start'
                        disabled={start_disabled}
                        title={start_disabled_reasons.join(', ') || undefined}
                        onClick={handleStart}
                    >
                        {isStarting ? localize('Starting…') : localize('Start AI agent')}
                    </button>
                ) : (
                    <button type='button' className='ai-agent-panel__stop' onClick={handleStop}>
                        {localize('Stop AI agent')}
                    </button>
                )}
                {start_disabled_reasons.length > 0 && !is_running && (
                    <span className='ai-agent-panel__hint'>{start_disabled_reasons.join(' · ')}</span>
                )}
            </div>

            {runStatus && (
                <dl className='ai-agent-panel__stats'>
                    <div>
                        <dt>{localize('Status')}</dt>
                        <dd>{runStatus.agent.status}</dd>
                    </div>
                    <div>
                        <dt>{localize('Trades')}</dt>
                        <dd>{runStatus.agent.trades}</dd>
                    </div>
                    <div>
                        <dt>{localize('Win / Loss')}</dt>
                        <dd>
                            {runStatus.agent.wins} / {runStatus.agent.losses}
                        </dd>
                    </div>
                    <div>
                        <dt>{localize('Net profit')}</dt>
                        <dd className={runStatus.agent.total_profit >= 0 ? 'is-positive' : 'is-negative'}>
                            {runStatus.agent.total_profit}
                        </dd>
                    </div>
                    {runStatus.agent.stop_reason && (
                        <div>
                            <dt>{localize('Stopped because')}</dt>
                            <dd>{runStatus.agent.stop_reason}</dd>
                        </div>
                    )}
                    {runStatus.agent.error && (
                        <div>
                            <dt>{localize('Error')}</dt>
                            <dd className='is-negative'>{runStatus.agent.error}</dd>
                        </div>
                    )}
                </dl>
            )}

            <AiAgentPipeline events={events} />
        </section>
    );
};

export default AiAgentPanel;
