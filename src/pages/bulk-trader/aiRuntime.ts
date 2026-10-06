// Everything about a running AI auto-pilot that must outlive the AI tab.
//
// The tabs are unmounted when you switch away (AI -> Journal), and the engine, its Deriv connection, its
// learner and its signal feed used to live in that component's refs, with a cleanup that stopped the
// run. They live here instead, at module level, so a run keeps trading while another tab is open and the
// panel simply re-attaches (reading this state) when you come back.
import { useSyncExternalStore } from 'react';
import { activeAccount } from '../journal/derivMapping';
import type { AutoPilotEngine, TAutoPilotConfig, TRiskLevel } from './autoPilotEngine';
import type { DerivClientConnection } from './derivClient';
import type { LearningEngine, TLearningMode } from './learningEngine';
import type { TTradeRow } from './tradeHistory';
import { retainSignals } from './useDigitSignals';

export type TAiStatus = 'idle' | 'connecting' | 'running' | 'stopped' | 'error';

export type TLadderRow = {
    step: number;
    symbol: string;
    label: string;
    stake: number;
    tag?: 'flipped' | 'switched' | 'streak';
    result?: 'win' | 'loss';
    profit?: number;
};

export type TAiActivity = { ts: number; kind: string; text: string };

export type TAiState = {
    status: TAiStatus;
    stopReason: string | undefined;
    error: string | null;
    totalProfit: number;
    ladder: TLadderRow[];
    history: TTradeRow[];
    activity: TAiActivity[];
    config: TAutoPilotConfig | null;
    riskLevel: TRiskLevel;
    learnMode: TLearningMode;
};

let state: TAiState = {
    status: 'idle',
    stopReason: undefined,
    error: null,
    totalProfit: 0,
    ladder: [],
    history: [],
    activity: [],
    config: null,
    riskLevel: 'moderate',
    learnMode: 'learn',
};

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
};

type TSetter<K extends keyof TAiState> = (value: TAiState[K] | ((prev: TAiState[K]) => TAiState[K])) => void;

// Same call shape as a React useState setter (a value or an updater), so the panel's code is unchanged.
const makeSetter =
    <K extends keyof TAiState>(key: K): TSetter<K> =>
    value => {
        const next = typeof value === 'function' ? (value as (prev: TAiState[K]) => TAiState[K])(state[key]) : value;
        if (Object.is(next, state[key])) return;
        state = { ...state, [key]: next };
        listeners.forEach(l => l());
    };

export const aiSet = {
    status: makeSetter('status'),
    stopReason: makeSetter('stopReason'),
    error: makeSetter('error'),
    totalProfit: makeSetter('totalProfit'),
    ladder: makeSetter('ladder'),
    history: makeSetter('history'),
    activity: makeSetter('activity'),
    config: makeSetter('config'),
    riskLevel: makeSetter('riskLevel'),
    learnMode: makeSetter('learnMode'),
};

/** Same shape as a React ref, but not tied to any component. */
const box = <T>(initial: T) => ({ current: initial });

export const aiRuntime = {
    engineRef: box<AutoPilotEngine | null>(null),
    connectionRef: box<DerivClientConnection | null>(null),
    learnerRef: box<LearningEngine | null>(null),
    /** The hard stop-loss cap the AI may never exceed (set from the risk preset). */
    capStopLossRef: box(0),
    /** How many AI panels are on screen right now. */
    mounted: 0,
    get: () => state,
};

export const useAiRuntime = (): TAiState => useSyncExternalStore(subscribe, aiRuntime.get);

// ---- while a run is going --------------------------------------------------------------------

let release_signals: (() => void) | null = null;
let account_timer: ReturnType<typeof setInterval> | null = null;

const stopWatchingAccount = () => {
    if (account_timer) clearInterval(account_timer);
    account_timer = null;
};

/** Keeps the live signal feed open for the engine, whether or not the AI tab is on screen. */
export const holdSignals = () => {
    if (!release_signals) release_signals = retainSignals();
};

/**
 * With the AI tab closed nothing else notices a demo <-> real switch in the header, and the run must never
 * carry on trading on a different account than the one on screen. So the run watches for it itself.
 */
export const watchAccount = () => {
    stopWatchingAccount();
    account_timer = setInterval(() => {
        const engine = aiRuntime.engineRef.current;
        const bound = aiRuntime.connectionRef.current?.accountInfo?.loginid;
        if (!engine?.isRunning) return stopWatchingAccount();
        const now = activeAccount();
        if (bound && now !== 'unknown' && now !== bound) {
            engine.stop('the active account was switched in the header');
        }
    }, 2000);
};

/**
 * Called when the engine reports it has stopped or failed: lets go of the signal feed and, if no AI panel
 * is on screen to own it, closes the Deriv connection too.
 */
export const releaseRun = () => {
    stopWatchingAccount();
    release_signals?.();
    release_signals = null;
    if (aiRuntime.mounted === 0) {
        aiRuntime.connectionRef.current?.close();
        aiRuntime.connectionRef.current = null;
    }
};
