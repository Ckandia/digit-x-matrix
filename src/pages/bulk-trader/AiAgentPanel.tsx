import React, { useEffect, useMemo, useRef, useState } from 'react';
import { localize } from '@deriv-com/translations';
import { useApiBase } from '@/hooks/useApiBase';
import { getActiveToken } from './tokenStorage';
import { DerivClientConnection } from './derivClient';
import { useDigitSignals } from './useDigitSignals';
import {
    AutoPilotEngine,
    buildConfigFromPreset,
    RISK_PRESETS,
    TAutoPilotConfig,
    TAutoPilotEvent,
    TRiskLevel,
} from './autoPilotEngine';
import { useStore } from '@/hooks/useStore';
import { MessageTypes } from '@/external/bot-skeleton';
import { LearningEngine, makeProfileId, TLearningMode } from './learningEngine';
import { labReport, suggestLimits, TLabRow } from './strategyLab';
import './ai-agent-panel.scss';

type TLadderRow = {
    step: number;
    symbol: string;
    label: string;
    stake: number;
    flipped: boolean;
    result?: 'win' | 'loss';
    profit?: number;
};

const RISK_LEVELS: { value: TRiskLevel; label: string }[] = [
    { value: 'conservative', label: 'Conservative' },
    { value: 'moderate', label: 'Moderate' },
    { value: 'aggressive', label: 'Aggressive' },
];

const AiAgentPanel = ({
    hasAcceptedRisk,
    onNeedsRiskAccept,
}: {
    hasAcceptedRisk: boolean;
    onNeedsRiskAccept: () => void;
}) => {
    const { snapshots } = useDigitSignals();
    const { run_panel, transactions, summary_card, journal } = useStore();
    const { isAuthorized, authData, activeLoginid } = useApiBase();
    const snapshotsRef = useRef(snapshots);
    useEffect(() => {
        snapshotsRef.current = snapshots;
    }, [snapshots]);

    const [riskLevel, setRiskLevel] = useState<TRiskLevel>('moderate');
    const [balance, setBalance] = useState<number | null>(null);
    const [currency, setCurrency] = useState('USD');
    const [config, setConfig] = useState<TAutoPilotConfig | null>(null);

    const [status, setStatus] = useState<'idle' | 'connecting' | 'running' | 'stopped' | 'error'>('idle');
    const [stopReason, setStopReason] = useState<string | undefined>();
    const [error, setError] = useState<string | null>(null);
    const [totalProfit, setTotalProfit] = useState(0);
    const [ladder, setLadder] = useState<TLadderRow[]>([]);

    const [learnMode, setLearnMode] = useState<TLearningMode>('learn');
    const [learnInfo, setLearnInfo] = useState<ReturnType<LearningEngine['summary']> | null>(null);
    const [labRows, setLabRows] = useState<TLabRow[]>([]);
    const [limitNote, setLimitNote] = useState('');
    const learnerRef = useRef<LearningEngine | null>(null);
    const capStopLossRef = useRef(0);
    const connectionRef = useRef<DerivClientConnection | null>(null);
    const engineRef = useRef<AutoPilotEngine | null>(null);
    const is_running = status === 'running';

    const [connectError, setConnectError] = useState<string | null>(null);
    const [isConnecting, setIsConnecting] = useState(false);

    // Opens this tab's own trading connection and reads the balance. Errors
    // are shown (not swallowed) so "not connected" always says why.
    const connectAccount = React.useCallback(async () => {
        const token = getActiveToken();
        if (!token) {
            setConnectError(localize('No active login found. Log in with your Deriv account first.'));
            return;
        }
        setIsConnecting(true);
        setConnectError(null);
        try {
            connectionRef.current?.close();
            const connection = new DerivClientConnection(token);
            const auth = await connection.connect();
            connectionRef.current = connection;
            setBalance(auth.authorize.balance ?? 0);
            setCurrency(auth.authorize.currency || 'USD');
        } catch (err) {
            setConnectError(err instanceof Error ? err.message : localize('Could not connect to Deriv.'));
        } finally {
            setIsConnecting(false);
        }
    }, []);

    useEffect(() => {
        connectAccount();
        return () => {
            if (!engineRef.current) connectionRef.current?.close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // If our own connection couldn't read a balance, fall back to the one the
    // main app already has for the active account so presets still show.
    useEffect(() => {
        if (balance == null && typeof authData?.balance === 'number') {
            setBalance(authData.balance);
            setCurrency(authData.currency || 'USD');
        }
    }, [authData, balance]);

    // Recompute the preset's numbers whenever the level or balance changes,
    // as long as nothing is running — this intentionally overwrites any
    // manual edits, since picking a preset is "start over from here."
    useEffect(() => {
        if (is_running || balance == null) return;
        const preset_config = buildConfigFromPreset(riskLevel, balance);
        capStopLossRef.current = preset_config.stop_loss; // the hard cap the AI may never exceed
        setConfig(preset_config);
    }, [riskLevel, balance, is_running]);

    const updateField = (key: keyof TAutoPilotConfig, value: number) => {
        setConfig(prev => (prev ? { ...prev, [key]: value } : prev));
    };

    const handleEngineEvent = (event: TAutoPilotEvent) => {
        if (event.phase === 'started') {
            setStatus('running');
            setLadder([]);
            setTotalProfit(0);
        } else if (event.phase === 'entering' && event.symbol && event.contract_type) {
            setLadder(prev => [
                ...prev,
                {
                    step: event.step || 1,
                    symbol: event.symbol!,
                    label: event.label || event.contract_type!,
                    stake: event.stake || 0,
                    flipped: (event.step || 1) > 1,
                },
            ]);
        } else if (event.phase === 'settled') {
            setLadder(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last) {
                    last.result = event.result;
                    last.profit = event.profit;
                }
                return next;
            });
            setTotalProfit(event.total_profit ?? 0);
            if (learnerRef.current) setLearnInfo(learnerRef.current.summary());
        } else if (event.phase === 'stopped') {
            setStatus('stopped');
            setStopReason(event.reason);
            journal.pushMessage(`AI auto-pilot stopped: ${event.reason ?? 'no reason given'}`, MessageTypes.NOTIFY);
        } else if (event.phase === 'error') {
            setStatus('error');
            setError(event.error || 'Something went wrong.');
        }
    };

    const handleStart = async () => {
        setError(null);
        setStopReason(undefined);
        if (!hasAcceptedRisk) {
            onNeedsRiskAccept();
            return;
        }
        if (!config) {
            setError(localize('Still reading your account balance — try again in a moment.'));
            return;
        }
        const token = getActiveToken();
        if (!token) {
            setError(localize('No active session token found. Please log in again.'));
            return;
        }

        setStatus('connecting');
        try {
            let connection = connectionRef.current;
            if (!connection || !connection.isReady) {
                connection = new DerivClientConnection(token);
                const auth = await connection.connect();
                setBalance(auth.authorize.balance ?? 0);
                setCurrency(auth.authorize.currency || 'USD');
                connectionRef.current = connection;
            }

            if (!learnerRef.current) {
                const learner = new LearningEngine(await makeProfileId(activeLoginid || 'account'), learnMode);
                await learner.syncFromBackend();
                learnerRef.current = learner;
            }
            learnerRef.current.mode = learnMode;
            setLearnInfo(learnerRef.current.summary());

            const engine = new AutoPilotEngine(
                connection,
                currency,
                config,
                () => snapshotsRef.current,
                handleEngineEvent,
                learnerRef.current,
                {
                    onContract: contract => {
                        const c = { ...contract, id: contract.id ?? contract.contract_id };
                        transactions.onBotContractEvent(c as never);
                        summary_card.onBotContractEvent(c as never);
                        run_panel.onBotContractEvent(c as never);
                    },
                    onLog: (kind, message) =>
                        journal.pushMessage(
                            message,
                            kind === 'error' ? MessageTypes.ERROR : kind === 'success' ? MessageTypes.SUCCESS : MessageTypes.NOTIFY
                        ),
                }
            );
            run_panel.run_id = `ai-${Date.now()}`;
            journal.pushMessage('AI auto-pilot started', MessageTypes.NOTIFY);
            engineRef.current = engine;
            engine.start();
        } catch (err) {
            setStatus('error');
            setError(err instanceof Error ? err.message : localize('Could not connect to Deriv.'));
        }
    };

    const handleStop = () => engineRef.current?.stop('stopped by user');

    useEffect(() => {
        return () => {
            engineRef.current?.stop('panel closed');
            connectionRef.current?.close();
        };
    }, []);

    const bar = useMemo(() => {
        if (!config) return null;
        const span = config.stop_loss + config.take_profit;
        const marker_pct = span > 0 ? (config.stop_loss / span) * 100 : 50;
        const loss_pct = totalProfit < 0 ? clampPct((-totalProfit / config.stop_loss) * marker_pct) : 0;
        return { marker_pct, loss_pct };
    }, [config, totalProfit]);

    return (
        <section className='ai-agent-panel'>
            <header className='ai-agent-panel__header'>
                <h3>{localize('AI auto-trader')}</h3>
                <p>
                    {localize(
                        'Reads your balance, picks the stake and martingale from a risk level, and scans Even/Odd, Rise/Fall, Only Ups/Downs, Touch/No Touch, Ends Between/Outside, Asians, High/Low Tick and Reset Call/Put for the strongest signal. On a loss it flips to the opposite side and escalates stake to recover — this is a statistical deviation score, not a win-probability estimate.'
                    )}
                </p>
            </header>

            {error && <div className='ai-agent-panel__error'>{error}</div>}

            {!is_running ? (
                <div className='ai-agent-panel__card'>
                    <div className='ai-agent-panel__card-top'>
                        <span className='ai-agent-panel__card-title'>{localize('AI auto-trader')}</span>
                        <span className='ai-agent-panel__balance'>
                            {balance != null ? `${currency} ${balance.toFixed(2)}` : '—'}
                        </span>
                    </div>

                    <div className='ai-agent-panel__connection'>
                        <span
                            className={`ai-agent-panel__dot ai-agent-panel__dot--${
                                connectionRef.current?.isReady ? 'on' : 'off'
                            }`}
                        />
                        {connectionRef.current?.isReady ? (
                            <span>
                                {localize('Connected')} — <strong>{activeLoginid || '—'}</strong>
                            </span>
                        ) : (
                            <span>
                                {isConnecting
                                    ? localize('Connecting…')
                                    : connectError || (isAuthorized ? localize('Not connected') : localize('Log in to your Deriv account first.'))}
                            </span>
                        )}
                        {!connectionRef.current?.isReady && !isConnecting && (
                            <button type='button' className='ai-agent-panel__retry' onClick={connectAccount}>
                                {localize('Retry')}
                            </button>
                        )}
                    </div>

                    <div className='ai-agent-panel__preset-row'>
                        {RISK_LEVELS.map(level => (
                            <button
                                key={level.value}
                                type='button'
                                className={`ai-agent-panel__preset ${riskLevel === level.value ? 'ai-agent-panel__preset--active' : ''}`}
                                disabled={status === 'connecting'}
                                onClick={() => setRiskLevel(level.value)}
                            >
                                {localize(level.label)}
                            </button>
                        ))}
                    </div>

                    {config && (
                        <div className='ai-agent-panel__fields'>
                            <FieldBox
                                label={localize('Stake ({{pct}}%)', { pct: RISK_PRESETS[riskLevel].stake_pct })}
                                value={config.stake}
                                disabled={status === 'connecting'}
                                onChange={v => updateField('stake', v)}
                            />
                            <FieldBox
                                label={localize('Martingale multiplier')}
                                value={config.martingale_multiplier}
                                step={0.1}
                                disabled={status === 'connecting'}
                                onChange={v => updateField('martingale_multiplier', v)}
                            />
                            <FieldBox
                                label={localize('Max recovery steps')}
                                value={config.max_steps}
                                step={1}
                                disabled={status === 'connecting'}
                                onChange={v => updateField('max_steps', v)}
                            />
                            <FieldBox
                                label={localize('Stop loss ({{pct}}%)', { pct: RISK_PRESETS[riskLevel].stop_loss_pct })}
                                value={config.stop_loss}
                                disabled={status === 'connecting'}
                                onChange={v => updateField('stop_loss', v)}
                            />
                            <FieldBox
                                label={localize('Take profit ({{pct}}%)', { pct: RISK_PRESETS[riskLevel].take_profit_pct })}
                                value={config.take_profit}
                                disabled={status === 'connecting'}
                                onChange={v => updateField('take_profit', v)}
                            />
                        </div>
                    )}

                    <label className='ai-agent-panel__hint'>
                        {localize('Learning')}{' '}
                        <select value={learnMode} onChange={e => setLearnMode(e.target.value as TLearningMode)}>
                            <option value='learn'>{localize('Learn (explore with small stakes)')}</option>
                            <option value='edge_gate'>{localize('Only trade a proven edge')}</option>
                            <option value='off'>{localize('Off (signals only)')}</option>
                        </select>
                    </label>
                    <button
                        type='button'
                        className='ai-agent-panel__hint'
                        disabled={!config}
                        onClick={async () => {
                            if (!config) return;
                            if (!learnerRef.current) {
                                const created = new LearningEngine(await makeProfileId(activeLoginid || 'account'), learnMode);
                                await created.syncFromBackend();
                                learnerRef.current = created;
                                setLearnInfo(created.summary());
                            }
                            const learner = learnerRef.current;
                            const s = suggestLimits(learner, capStopLossRef.current || config.stop_loss);
                            setConfig({ ...config, stop_loss: s.stop_loss, take_profit: s.take_profit });
                            setLimitNote(s.reason);
                            setLabRows(
                                labReport(learner, s.take_profit / config.stake, s.stop_loss / config.stake, config.martingale_multiplier, config.max_steps)
                            );
                        }}
                    >
                        {localize('AI: set take profit / stop loss and test')}
                    </button>
                    {limitNote && <span className='ai-agent-panel__hint'>{limitNote}</span>}
                    {labRows.map(r => (
                        <span key={r.label} className='ai-agent-panel__hint'>
                            {r.label}: {r.n} trades, TP hit {(r.tp_hit * 100).toFixed(0)}% vs SL hit {(r.sl_hit * 100).toFixed(0)}%, avg{' '}
                            {r.expectancy.toFixed(2)} stakes/session
                            {r.verdict === 'illusion' && ' (more TP than SL hits, but still losing on average)'}
                            {r.verdict === 'proven_edge' && ' (proven edge)'}
                            {r.verdict === 'not_enough_data' && ' (need 30+ trades)'}
                        </span>
                    ))}
                    {learnInfo && learnInfo.total_trades > 0 && (
                        <span className='ai-agent-panel__hint'>
                            {localize('Learned from {{n}} trades across {{c}} market/contract/time-frame combinations; {{p}} show a proven edge.', {
                                n: learnInfo.total_trades,
                                c: learnInfo.combinations,
                                p: learnInfo.proven,
                            })}
                        </span>
                    )}
                    <button
                        type='button'
                        className='ai-agent-panel__start'
                        disabled={!config || status === 'connecting'}
                        onClick={handleStart}
                    >
                        {status === 'connecting' ? localize('Starting…') : localize('Start AI auto-trader')}
                    </button>
                    {stopReason && status === 'stopped' && (
                        <span className='ai-agent-panel__hint'>
                            {localize('Last run stopped: {{reason}}', { reason: stopReason })}
                        </span>
                    )}
                </div>
            ) : (
                <div className='ai-agent-panel__card'>
                    <div className='ai-agent-panel__card-top'>
                        <span className='ai-agent-panel__card-title'>{localize('Running')}</span>
                        <span className='ai-agent-panel__scanning'>{localize('scanning')}</span>
                    </div>

                    <div className='ai-agent-panel__stats-grid'>
                        <dl className='ai-agent-panel__stat-box'>
                            <dt>{localize('Balance')}</dt>
                            <dd>
                                {currency} {balance != null ? (balance + totalProfit).toFixed(2) : '—'}
                            </dd>
                        </dl>
                        <dl className='ai-agent-panel__stat-box'>
                            <dt>{localize('Net profit')}</dt>
                            <dd style={{ color: totalProfit >= 0 ? '#5dcaa5' : '#f0997b' }}>
                                {totalProfit >= 0 ? '+' : ''}
                                {totalProfit.toFixed(2)}
                            </dd>
                        </dl>
                    </div>

                    <div className='ai-agent-panel__ladder'>
                        <div className='ai-agent-panel__ladder-title'>
                            <span>
                                {localize('Recovery ladder — step {{step}} of {{max}}', {
                                    step: ladder.length ? ladder[ladder.length - 1].step : 1,
                                    max: config?.max_steps ?? 1,
                                })}
                            </span>
                            {ladder.length > 1 && (
                                <span className='ai-agent-panel__ladder-loss-count'>
                                    {localize('{{n}} loss', { n: ladder.length - 1 })}
                                </span>
                            )}
                        </div>
                        <div className='ai-agent-panel__ladder-rows'>
                            {ladder.map((row, i) => (
                                <div
                                    key={i}
                                    className={`ai-agent-panel__ladder-row ${
                                        row.result === 'win'
                                            ? 'ai-agent-panel__ladder-row--win'
                                            : row.result === 'loss'
                                              ? 'ai-agent-panel__ladder-row--loss'
                                              : ''
                                    }`}
                                >
                                    <span>
                                        {row.step} · {row.symbol} · {row.label}
                                        {row.flipped && <span className='ai-agent-panel__ladder-flip'>{'\u21ba flipped'}</span>}
                                    </span>
                                    <span>
                                        {row.result === undefined
                                            ? `${row.stake.toFixed(2)} open`
                                            : row.result === 'win'
                                              ? `+${row.profit?.toFixed(2)} win`
                                              : `${row.profit?.toFixed(2)} lost`}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className='ai-agent-panel__ladder-note'>
                            {localize('Step {{max}} auto-stops the run — that is the ceiling, not a target.', {
                                max: config?.max_steps ?? 1,
                            })}
                        </div>
                    </div>

                    {config && bar && (
                        <>
                            <div className='ai-agent-panel__bar-labels'>
                                <span>{localize('Stop loss')}</span>
                                <span>{localize('Take profit')}</span>
                            </div>
                            <div className='ai-agent-panel__bar-track'>
                                <div
                                    className='ai-agent-panel__bar-marker'
                                    style={{ left: `${bar.marker_pct}%` }}
                                />
                                <div className='ai-agent-panel__bar-fill' style={{ width: `${bar.loss_pct}%` }} />
                            </div>
                            <div className='ai-agent-panel__bar-footer'>
                                <span>-{config.stop_loss.toFixed(0)}</span>
                                <span className='ai-agent-panel__bar-now'>
                                    {localize('now: {{value}}', { value: totalProfit.toFixed(2) })}
                                </span>
                                <span>+{config.take_profit.toFixed(0)}</span>
                            </div>
                        </>
                    )}

                    <button type='button' className='ai-agent-panel__stop' onClick={handleStop}>
                        {localize('Stop now')}
                    </button>
                </div>
            )}
        </section>
    );
};

const clampPct = (value: number) => Math.max(0, Math.min(100, value));

const FieldBox = ({
    label,
    value,
    step = 0.01,
    disabled,
    onChange,
}: {
    label: string;
    value: number;
    step?: number;
    disabled?: boolean;
    onChange: (value: number) => void;
}) => (
    <div className='ai-agent-panel__field'>
        <span className='ai-agent-panel__field-label'>{label}</span>
        <input
            type='number'
            className='ai-agent-panel__field-input'
            value={value}
            step={step}
            disabled={disabled}
            onChange={e => onChange(Number(e.target.value))}
        />
    </div>
);

export default AiAgentPanel;
