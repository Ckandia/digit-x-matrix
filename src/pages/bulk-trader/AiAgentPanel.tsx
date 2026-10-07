import React, { useEffect, useMemo, useRef, useState } from 'react';
import { localize } from '@deriv-com/translations';
import { useApiBase } from '@/hooks/useApiBase';
import { getActiveToken } from './tokenStorage';
import { DerivClientConnection } from './derivClient';
import { getSignalSnapshots, useDigitSignals } from './useDigitSignals';
import { aiRuntime, aiSet, holdSignals, releaseRun, useAiRuntime, watchAccount } from './aiRuntime';
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
import { getDurationTicks, mergeTradeRow } from './tradeHistory';
import type { TRecoveryMode } from './autoPilotEngine';
import { LearningEngine, makeProfileId, TLearningMode } from './learningEngine';
import { keepScreenAwake } from './wakeLock';
import { loadLiveRules } from './contractRules';
import { CONTRACT_NOTES, playbookLines } from './tradingKnowledge';
import { activeAccount } from '../journal/derivMapping';
import { journalStore } from '../journal/journalStore';
import { labReport, suggestLimits, TLabRow } from './strategyLab';
import './ai-agent-panel.scss';

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

    // Run state lives in aiRuntime (module level), not in this component: switching to another tab unmounts
    // this panel, and the run must carry on and be here, intact, when you come back.
    const { status, stopReason, error, totalProfit, ladder, history, activity, config, riskLevel, learnMode } = useAiRuntime();
    const setStatus = aiSet.status;
    const setStopReason = aiSet.stopReason;
    const setError = aiSet.error;
    const setTotalProfit = aiSet.totalProfit;
    const setLadder = aiSet.ladder;
    const setHistory = aiSet.history;
    const setActivity = aiSet.activity;
    const setConfig = aiSet.config;
    const setRiskLevel = aiSet.riskLevel;
    const setLearnMode = aiSet.learnMode;
    const [balance, setBalance] = useState<number | null>(null);
    // The balance the risk-preset numbers (stake, stop loss, take profit) were built from. It is NOT
    // moved by every live balance tick, so editing a field is never overwritten mid-edit.
    const [presetBalance, setPresetBalance] = useState<number | null>(null);
    const [balanceLive, setBalanceLive] = useState(false);
    const [selfReviewOn, setSelfReviewOn] = useState(journalStore.selfReviewEnabled());
    const [connectedLoginid, setConnectedLoginid] = useState('');
    const [connectedType, setConnectedType] = useState('');
    const [currency, setCurrency] = useState('USD');


    const [learnInfo, setLearnInfo] = useState<ReturnType<LearningEngine['summary']> | null>(null);
    const [labRows, setLabRows] = useState<TLabRow[]>([]);
    const [limitNote, setLimitNote] = useState('');
    const { learnerRef, capStopLossRef, connectionRef, engineRef } = aiRuntime;
    const is_running = status === 'running';

    const [connectError, setConnectError] = useState<string | null>(null);
    const [isConnecting, setIsConnecting] = useState(false);

    // Opens a trading connection for the account that is active in the app and wires its LIVE
    // balance stream into the panel. Used by the first connect, by a header account switch, and by Start.
    const bindBalance = React.useCallback((connection: DerivClientConnection) => {
        connection.onBalance = (b, c) => {
            setBalance(b);
            setCurrency(c || 'USD');
            setBalanceLive(true);
            setPresetBalance(prev => prev ?? b);
        };
    }, []);

    const openConnection = React.useCallback(async (token: string) => {
        const connection = new DerivClientConnection(token);
        bindBalance(connection);
        const auth = await connection.connect();
        setBalance(auth.authorize.balance ?? 0);
        setCurrency(auth.authorize.currency || 'USD');
        setBalanceLive(connection.balanceLive);
        setConnectedLoginid(auth.authorize.loginid);
        setConnectedType(auth.authorize.type || '');
        setPresetBalance(prev => prev ?? (auth.authorize.balance ?? 0));
        return connection;
    }, [bindBalance]);

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
            connectionRef.current = await openConnection(token);
        } catch (err) {
            setConnectError(err instanceof Error ? err.message : localize('Could not connect to Deriv.'));
        } finally {
            setIsConnecting(false);
        }
    }, [openConnection]);

    useEffect(() => {
        aiRuntime.mounted += 1;
        const live_connection = connectionRef.current;
        if (engineRef.current?.isRunning && live_connection) {
            // The run kept going while this tab was closed: pick it up again instead of opening a second
            // connection (which would also drop the one the run is trading on).
            bindBalance(live_connection);
            const info = live_connection.accountInfo;
            if (info) {
                setBalance(info.balance ?? 0);
                setCurrency(info.currency || 'USD');
                setBalanceLive(live_connection.balanceLive);
                setConnectedLoginid(info.loginid);
                setConnectedType(info.type || '');
                setPresetBalance(prev => prev ?? (info.balance ?? 0));
            }
        } else {
            connectAccount();
        }
        return () => {
            aiRuntime.mounted -= 1;
            if (engineRef.current?.isRunning) {
                // Leaving the tab never stops a run. Just stop this (unmounted) panel listening for balance ticks.
                if (connectionRef.current) connectionRef.current.onBalance = null;
            } else if (aiRuntime.get().status !== 'connecting') {
                connectionRef.current?.close();
                connectionRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Show what the learner knows as the run progresses (and again when the tab is reopened).
    useEffect(() => {
        if (learnerRef.current) setLearnInfo(learnerRef.current.summary());
    }, [ladder, totalProfit]); // eslint-disable-line react-hooks/exhaustive-deps

    // After a run ends, rebuild the risk preset from the account's balance as it is now.
    useEffect(() => {
        if (status === 'stopped') setPresetBalance(connectionRef.current?.accountInfo?.balance ?? null);
    }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

    // If our own connection couldn't read a balance, fall back to the one the
    // main app already has for the active account so presets still show.
    useEffect(() => {
        if (balance == null && typeof authData?.balance === 'number') {
            setBalance(authData.balance);
            setCurrency(authData.currency || 'USD');
            setPresetBalance(prev => prev ?? authData.balance);
        }
    }, [authData, balance]);

    // The user switched account (demo <-> real) in the header. This panel's connection is bound to the
    // account it opened with, so left alone it would show and trade on the OLD account. A running AI
    // is stopped (it must never carry on trading on a different account than the one on screen);
    // then the panel reconnects to the new account and starts learning from that account's own record.
    const lastLoginidRef = useRef(activeLoginid);
    useEffect(() => {
        const previous = lastLoginidRef.current;
        lastLoginidRef.current = activeLoginid;
        const conn = connectionRef.current;
        const bound = conn?.accountInfo?.loginid;
        if (!activeLoginid || !bound || activeLoginid === bound) return;
        // Coming back to this tab (the panel was re-created) is NOT an account switch: a run that kept going
        // while another tab was open must never be stopped by it. Only a change made while this panel is on screen counts.
        if (engineRef.current?.isRunning && previous === activeLoginid) return;
        if (engineRef.current?.isRunning) engineRef.current.stop('the active account was switched in the header');
        learnerRef.current = null;
        setPresetBalance(null);
        setBalanceLive(false);
        void connectAccount();
    }, [activeLoginid, connectAccount]);

    // Recompute the preset's numbers whenever the level or balance changes,
    // as long as nothing is running — this intentionally overwrites any
    // manual edits, since picking a preset is "start over from here."
    useEffect(() => {
        if (is_running || presetBalance == null) return;
        const preset_config = buildConfigFromPreset(riskLevel, presetBalance);
        capStopLossRef.current = preset_config.stop_loss; // the hard cap the AI may never exceed
        setConfig(preset_config);
    }, [riskLevel, presetBalance, is_running]);

    const updateField = (key: keyof TAutoPilotConfig, value: number) => {
        setConfig(prev => (prev ? { ...prev, [key]: value } : prev));
    };

    const handleEngineEvent = (event: TAutoPilotEvent) => {
        if (event.phase === 'started') {
            setStatus('running');
            keepScreenAwake('ai', true);
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
                    tag: event.tag,
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
        } else if (event.phase === 'stopped') {
            setStatus('stopped');
            keepScreenAwake('ai', false);
            setStopReason(event.reason);
            journal.pushMessage(`AI auto-pilot stopped: ${event.reason ?? 'no reason given'}`, MessageTypes.NOTIFY);
            releaseRun();
        } else if (event.phase === 'error') {
            setStatus('error');
            keepScreenAwake('ai', false);
            setError(event.error || 'Something went wrong.');
            releaseRun();
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
            const on_wrong_account = !!activeLoginid && !!connection?.accountInfo && connection.accountInfo.loginid !== activeLoginid;
            if (!connection || !connection.isReady || on_wrong_account) {
                connection?.close();
                connection = await openConnection(token);
                connectionRef.current = connection;
                learnerRef.current = null;
            }
            if (activeLoginid && connection.accountInfo && connection.accountInfo.loginid !== activeLoginid) {
                connection.close();
                connectionRef.current = null;
                throw new Error(
                    localize('The AI connected to account {{ai}} but the header shows {{shown}}. Not starting, so it cannot trade on the wrong account.', {
                        ai: connection.accountInfo.loginid,
                        shown: activeLoginid,
                    })
                );
            }
            // Read the real balance right before trading, so the AI never works from a stale number.
            const live_balance = await connection.refreshBalance();
            if (live_balance != null) setBalance(live_balance);
            if (live_balance == null && !connection.balanceLive) {
                throw new Error(localize('Could not read your live account balance from Deriv. Try again in a moment.'));
            }
            const trade_currency = connection.accountInfo?.currency || currency;

            await loadLiveRules(Object.keys(snapshotsRef.current));
            if (!learnerRef.current) {
                const learner = new LearningEngine(await makeProfileId(connection.accountInfo?.loginid || activeLoginid || 'account'), learnMode);
                await learner.syncFromBackend();
                learnerRef.current = learner;
            }
            learnerRef.current.mode = learnMode;
            setLearnInfo(learnerRef.current.summary());

            const journal_account = connection.accountInfo?.loginid || activeLoginid || activeAccount();
            const logLine = (kind: 'info' | 'success' | 'error', message: string) => {
                setActivity(prev => [{ ts: Date.now(), kind, text: message }, ...prev].slice(0, 40));
                journal.pushMessage(
                    message,
                    kind === 'error' ? MessageTypes.ERROR : kind === 'success' ? MessageTypes.SUCCESS : MessageTypes.NOTIFY
                );
            };
            const engine = new AutoPilotEngine(
                connection,
                trade_currency,
                config,
                getSignalSnapshots,
                handleEngineEvent,
                learnerRef.current,
                {
                    onContract: contract => {
                        setHistory(prev => mergeTradeRow(prev, contract));
                        const c = { ...contract, id: contract.id ?? contract.contract_id };
                        transactions.onBotContractEvent(c as never);
                        summary_card.onBotContractEvent(c as never);
                        run_panel.onBotContractEvent(c as never);
                    },
                    onLog: logLine,
                    // Every settled trade goes into the journal with the AI's own context, so it can review itself.
                    onSettled: s =>
                        journalStore.addAi(
                            {
                                id: s.contract_id,
                                account: journal_account,
                                symbol: s.symbol,
                                type: s.contract_type,
                                stake: s.stake,
                                payout: s.payout,
                                profit: s.profit,
                                buy_ts: s.buy_ts,
                                sell_ts: s.sell_ts,
                                ticks: s.duration_ticks,
                                source: 'ai',
                            },
                            { strategy: s.strategy, step: s.step, base_stake: s.base_stake, mode: s.mode, confidence: s.confidence, tag: s.tag }
                        ),
                    // Before each pick the AI consults its own record: skip proven losers, rank lagging ones lower.
                    gate: () => journalStore.gate(journal_account),
                }
            );
            run_panel.run_id = `ai-${Date.now()}`;
            run_panel.toggleDrawer(true);
            journal.pushMessage('AI auto-pilot started', MessageTypes.NOTIFY);
            engineRef.current = engine;
            // Start by reading out what the AI concluded about its own past trades.
            if (journalStore.selfReviewEnabled()) {
                journalStore
                    .review(journal_account)
                    .lines.slice(0, 3)
                    .forEach(line => logLine('info', `Self-review: ${line}`));
            }
            holdSignals(); // the run keeps its own hold on the live signals, so leaving this tab does not starve it
            watchAccount();
            engine.start();
        } catch (err) {
            setStatus('error');
            setError(err instanceof Error ? err.message : localize('Could not connect to Deriv.'));
        }
    };

    const handleStop = () => engineRef.current?.stop('stopped by user');

    const closed = history.filter(r => !r.open);

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
                        'Reads your balance, sets the stake from a risk level, and scans every market for Even/Odd (including your streak-reversal rule) and Rise/Fall on the next tick, plus the barrier contracts (Touch/No Touch, Stays Between/Goes Outside) when the market state suits them, and picks the market and contract with the strongest signal, all on 1 tick (barrier contracts use the shortest duration Deriv offers). Every trade is priced with Deriv first, so a contract Deriv would reject is skipped before any money is spent. The stake grows only on a winning streak (reverse martingale) and returns to the base stake after a loss; after 2 losses in a row it switches to a different contract. The signal is a statistical deviation score, not a win-probability estimate.'
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
                            {balance != null && (
                                <small style={{ marginLeft: 6, opacity: 0.7 }}>
                                    {balanceLive ? localize('live') : localize('last known')}
                                </small>
                            )}
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
                                {localize('Connected')} — <strong>{connectedLoginid || activeLoginid || '—'}</strong>
                                {connectedType ? ` (${connectedType})` : ''}
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
                            {(config.recovery_mode ?? 'reverse') === 'reverse' ? (
                                <>
                                    <FieldBox
                                        label={localize('Stake growth per win (x)')}
                                        value={config.streak_multiplier ?? 1.8}
                                        step={0.1}
                                        disabled={status === 'connecting'}
                                        onChange={v => updateField('streak_multiplier', v)}
                                    />
                                    <FieldBox
                                        label={localize('Wins in a row before banking')}
                                        value={config.max_streak ?? 3}
                                        step={1}
                                        disabled={status === 'connecting'}
                                        onChange={v => updateField('max_streak', v)}
                                    />
                                </>
                            ) : (
                                <>
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
                                </>
                            )}
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
                            <FieldBox
                                label={localize('Protect capital: first N trades (0 = off)')}
                                value={config.protect_trades ?? 0}
                                step={1}
                                disabled={status === 'connecting'}
                                onChange={v => updateField('protect_trades', Math.max(0, Math.floor(v)))}
                            />
                        </div>
                    )}

                    <label className='ai-agent-panel__hint'>
                        <input
                            type='checkbox'
                            checked={!!config?.virtual_hook}
                            disabled={!config || status === 'connecting'}
                            onChange={e => config && setConfig({ ...config, virtual_hook: e.target.checked })}
                        />{' '}
                        {localize(
                            'Virtual hook: after a real loss the AI stops risking money and trades on paper (switching contracts the same way) until a paper trade wins, then resumes real trading.'
                        )}
                    </label>

                    <label className='ai-agent-panel__hint'>
                        <input
                            type='checkbox'
                            checked={!!config?.auto_flip}
                            disabled={!config || status === 'connecting'}
                            onChange={e => config && setConfig({ ...config, auto_flip: e.target.checked })}
                        />{' '}
                        {localize(
                            'Auto flip: after a loss the AI switches to the partner contract, and after the next loss it switches back. Pairs: Even / Over 4, Odd / Under 5, Touch / Under 5, No Touch / Over 4, Rise / Under 5, Fall / Over 4.'
                        )}
                    </label>

                    <label className='ai-agent-panel__hint'>
                        {localize('Stake method')}{' '}
                        <select
                            value={config?.recovery_mode ?? 'reverse'}
                            disabled={!config}
                            onChange={e => config && setConfig({ ...config, recovery_mode: e.target.value as TRecoveryMode })}
                        >
                            <option value='reverse'>{localize('Reverse martingale: bigger stake after wins, base stake after a loss')}</option>
                            <option value='martingale'>{localize('Classic martingale: same side, bigger stake after a loss')}</option>
                            <option value='flip'>{localize('Auto-flip: opposite side, bigger stake')}</option>
                            <option value='flat'>{localize('Flat: same stake, no recovery')}</option>
                        </select>
                    </label>
                    <p className='ai-agent-panel__hint'>
                        {localize(
                            'Conservative / Moderate / Aggressive change the stake sizes only (stake, stake growth, stop loss, take profit). They never change which contracts the AI trades. After 2 losses in a row the AI switches to a different contract.'
                        )}
                    </p>
                    <p className='ai-agent-panel__hint'>
                        {localize(
                            'Quick contracts first: 1-tick contracts (Even/Odd, Over 4/Under 5, Rise/Fall) are always preferred; Touch/No Touch (5 ticks, barrier 0.5, or 10 ticks if Deriv refuses 5) is used only when no 1-tick contract is available. Rise needs a higher-high and Fall a lower-low on the 1-tick chart first. Capital protection: for the first N trades the stake stays at the base stake and the run stops if it loses 3 base stakes. It reduces risk; it cannot guarantee profit.'
                        )}
                    </p>
                    <details className='ai-agent-panel__hint'>
                        <summary>{localize('AI playbook (your notes)')}</summary>
                        <ul>
                            {playbookLines().map(line => (
                                <li key={line}>{localize(line)}</li>
                            ))}
                        </ul>
                        <ul>
                            {CONTRACT_NOTES.filter(n => !n.supported).map(n => (
                                <li key={n.name}>
                                    <strong>{n.name}</strong>: {n.unsupported_reason}
                                </li>
                            ))}
                        </ul>
                    </details>
                    <label className='ai-agent-panel__hint'>
                        <input
                            type='checkbox'
                            checked={selfReviewOn}
                            disabled={status === 'connecting'}
                            onChange={e => {
                                setSelfReviewOn(e.target.checked);
                                journalStore.setSelfReviewEnabled(e.target.checked);
                            }}
                        />{' '}
                        {localize(
                            'Let the AI use its self-review: it skips market and contract combinations its own past trades show are clearly losing, and ranks lagging ones lower. The full review is in the Journal tab.'
                        )}
                    </label>
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
                                labReport(learner, s.take_profit / config.stake, s.stop_loss / config.stake, (config.recovery_mode ?? 'reverse') === 'reverse' ? 1 : config.martingale_multiplier, (config.recovery_mode ?? 'reverse') === 'reverse' ? 1 : config.max_steps)
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
                                {currency} {balance != null ? balance.toFixed(2) : '—'}
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
                                {(config?.recovery_mode ?? 'reverse') === 'reverse'
                                    ? localize('Win streak — stake step {{step}} of {{max}}', {
                                          step: ladder.length ? ladder[ladder.length - 1].step : 1,
                                          max: Math.floor(config?.max_streak ?? 3),
                                      })
                                    : localize('Recovery ladder — step {{step}} of {{max}}', {
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
                                        {row.tag === 'flipped' && <span className='ai-agent-panel__ladder-flip'>{'\u21ba flipped'}</span>}
                                        {row.tag === 'switched' && <span className='ai-agent-panel__ladder-flip'>{'\u21c4 switched contract'}</span>}
                                        {row.tag === 'streak' && <span className='ai-agent-panel__ladder-flip'>{'\u25b2 win streak'}</span>}
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
                            {(config?.recovery_mode ?? 'reverse') === 'reverse'
                                ? localize('The stake only grows after a win and goes back to the base stake after any loss.')
                                : localize('Step {{max}} auto-stops the run — that is the ceiling, not a target.', {
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

            {(history.length > 0 || activity.length > 0) && (
                <div className='ai-agent-panel__history'>
                    <div className='ai-agent-panel__history-head'>
                        <strong>{localize('AI trade results')}</strong>
                        <span>
                            {localize('{{n}} trades, {{w}} won, {{l}} lost, net {{p}}', {
                                n: closed.length,
                                w: closed.filter(r => r.profit > 0).length,
                                l: closed.filter(r => r.profit <= 0).length,
                                p: closed.reduce((a, r) => a + r.profit, 0).toFixed(2),
                            })}
                        </span>
                        <button
                            type='button'
                            className='ai-agent-panel__retry'
                            onClick={() => {
                                setHistory([]);
                                setActivity([]);
                            }}
                        >
                            {localize('Clear')}
                        </button>
                    </div>
                    {history.length > 0 && (
                        <div className='ai-agent-panel__history-scroll'>
                            <table className='ai-agent-panel__history-table'>
                                <thead>
                                    <tr>
                                        <th>{localize('Time')}</th>
                                        <th>{localize('Market')}</th>
                                        <th>{localize('Contract')}</th>
                                        <th>{localize('Ticks')}</th>
                                        <th>{localize('Stake')}</th>
                                        <th>{localize('P/L')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {history.map(r => (
                                        <tr key={r.id}>
                                            <td>{new Date(r.ts * 1000).toLocaleTimeString()}</td>
                                            <td>{r.symbol}</td>
                                            <td>{r.type}</td>
                                            <td>{getDurationTicks(r) ?? '-'}</td>
                                            <td>{r.stake.toFixed(2)}</td>
                                            <td className={r.open ? '' : r.profit > 0 ? 'is-win' : 'is-loss'}>
                                                {r.open ? localize('open') : r.profit.toFixed(2)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {activity.length > 0 && (
                        <div className='ai-agent-panel__activity'>
                            <strong>{localize('Activity and errors')}</strong>
                            {activity.map((a, i) => (
                                <div key={`${a.ts}-${i}`} className={`ai-agent-panel__activity-line is-${a.kind}`}>
                                    {new Date(a.ts).toLocaleTimeString()} {a.text}
                                </div>
                            ))}
                        </div>
                    )}
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
