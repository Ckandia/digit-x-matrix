// The AI auto-pilot as a run that does NOT need a browser. The backend (backend/src/runner) bundles this file together with
// the very same AutoPilotEngine the AI tab uses, gives it a Node WebSocket connection to Deriv and the backend's own live
// market feed, and keeps the run going when every browser tab, laptop and phone is closed.
//
// It keeps the same state the AI tab shows (ladder, activity, paper trades, history, total profit) and hands it out as one
// JSON object, so the tab can simply display it while the run lives on the server.
//
// Browser-free on purpose: no React, no localStorage, no window. (The learner and rules code only touch localStorage inside
// try/catch, and the engine reads the backend over fetch, which Node has.)
import { AutoPilotEngine, TAutoPilotConfig, TAutoPilotEvent, TSettledTrade } from './autoPilotEngine';
import type { TSnapshotMap } from './analysis-types';
import type { DerivClientConnection } from './derivClient';
import { LearningEngine, makeProfileId, TLearningMode } from './learningEngine';
import { loadLiveRules } from './contractRules';
import { mergeTradeRow, TTradeRow } from './tradeHistory';

export type TServerLadderRow = {
    step: number;
    symbol: string;
    label: string;
    stake: number;
    tag?: 'flipped' | 'switched' | 'streak';
    result?: 'win' | 'loss';
    profit?: number;
};

export type TServerRunState = {
    status: 'connecting' | 'running' | 'stopped' | 'error';
    stopReason?: string;
    error: string | null;
    totalProfit: number;
    ladder: TServerLadderRow[];
    history: TTradeRow[];
    activity: { ts: number; kind: string; text: string }[];
    virtual: {
        active: boolean;
        current: string;
        losses: number;
        wins: number;
        needed: number;
        rows: { ts: number; symbol: string; label: string; result: 'win' | 'loss' }[];
    };
    started_at: number;
    updated_at: number;
};

export type TServerRunOptions = {
    connection: DerivClientConnection;
    currency: string;
    loginid: string;
    config: TAutoPilotConfig;
    learnMode?: TLearningMode;
    getSnapshots: () => TSnapshotMap;
    /** Profit already realised by an earlier part of this same run (a resumed run), so the loss limit is not reset by a restart. */
    carried_profit?: number;
    /** Called after every state change (the backend uses it to save the run's progress). */
    onChange?: (state: TServerRunState) => void;
    /** Every settled trade, for the backend's own record. */
    onSettled?: (trade: TSettledTrade) => void;
};

const emptyVirtual = (): TServerRunState['virtual'] => ({ active: false, current: '', losses: 0, wins: 0, needed: 2, rows: [] });

const MAX_ACTIVITY = 60;

export class ServerRun {
    private opts: TServerRunOptions;
    private engine: AutoPilotEngine | null = null;
    private state: TServerRunState;

    constructor(opts: TServerRunOptions) {
        this.opts = opts;
        this.state = {
            status: 'connecting',
            error: null,
            totalProfit: 0,
            ladder: [],
            history: [],
            activity: [],
            virtual: emptyVirtual(),
            started_at: Date.now(),
            updated_at: Date.now(),
        };
    }

    getState(): TServerRunState {
        return this.state;
    }

    get isRunning(): boolean {
        return !!this.engine?.isRunning;
    }

    private patch(next: Partial<TServerRunState>) {
        this.state = { ...this.state, ...next, updated_at: Date.now() };
        try {
            this.opts.onChange?.(this.state);
        } catch {
            /* the saver must never stop trading */
        }
    }

    private log(kind: 'info' | 'success' | 'error', text: string) {
        this.patch({ activity: [{ ts: Date.now(), kind, text }, ...this.state.activity].slice(0, MAX_ACTIVITY) });
    }

    /** Same reading of the engine's events as the AI tab's own handler. */
    private onEvent = (event: TAutoPilotEvent) => {
        const s = this.state;
        if (event.phase === 'started') {
            this.patch({ status: 'running', ladder: [], totalProfit: this.opts.carried_profit ?? 0, virtual: { ...s.virtual, active: false, current: '', losses: 0, wins: 0 } });
        } else if (event.phase === 'virtual') {
            const what = `${event.label ?? event.contract_type ?? ''} on ${event.symbol ?? ''}`.trim();
            if (event.virtual_state === 'result' && event.result) {
                const row = { ts: Date.now(), symbol: event.symbol ?? '', label: event.label ?? '', result: event.result };
                this.patch({
                    virtual: {
                        ...s.virtual,
                        losses: event.virtual_losses ?? s.virtual.losses,
                        wins: event.virtual_wins ?? s.virtual.wins,
                        needed: event.virtual_needed ?? s.virtual.needed,
                        rows: [row, ...s.virtual.rows].slice(0, 50),
                    },
                });
            } else if (event.virtual_state === 'end') {
                this.patch({ virtual: { ...s.virtual, active: false, current: '' } });
            } else {
                this.patch({
                    virtual: {
                        ...s.virtual,
                        active: true,
                        current: what,
                        losses: event.virtual_losses ?? s.virtual.losses,
                        wins: event.virtual_wins ?? s.virtual.wins,
                        needed: event.virtual_needed ?? s.virtual.needed,
                    },
                });
            }
        } else if (event.phase === 'entering' && event.symbol && event.contract_type) {
            this.patch({
                ladder: [
                    ...s.ladder,
                    { step: event.step || 1, symbol: event.symbol, label: event.label || event.contract_type, stake: event.stake || 0, tag: event.tag },
                ].slice(-200),
            });
        } else if (event.phase === 'settled') {
            const ladder = s.ladder.map(r => ({ ...r }));
            const last = ladder[ladder.length - 1];
            if (last) {
                last.result = event.result;
                last.profit = event.profit;
            }
            this.patch({ ladder, totalProfit: (this.opts.carried_profit ?? 0) + (event.total_profit ?? 0) });
        } else if (event.phase === 'stopped') {
            this.patch({ status: 'stopped', stopReason: event.reason, virtual: { ...s.virtual, active: false, current: '' } });
            this.log('info', `AI auto-pilot stopped: ${event.reason ?? 'no reason given'}`);
            this.finish();
        } else if (event.phase === 'error') {
            this.patch({ status: 'error', error: event.error || 'Something went wrong.', virtual: { ...s.virtual, active: false, current: '' } });
            this.finish();
        }
    };

    private finish() {
        try {
            this.opts.connection.close();
        } catch {
            /* already closed */
        }
    }

    async start() {
        const { connection, currency, config, learnMode = 'learn', getSnapshots, loginid } = this.opts;
        await loadLiveRules(Object.keys(getSnapshots()));
        const learner = new LearningEngine(await makeProfileId(loginid || 'account'), learnMode);
        try {
            await learner.syncFromBackend();
            await learner.syncPaper();
        } catch {
            /* the learner just starts with what it has */
        }
        learner.mode = learnMode;
        this.engine = new AutoPilotEngine(connection, currency, config, getSnapshots, this.onEvent, learner, {
            onContract: contract => this.patch({ history: mergeTradeRow(this.state.history, contract) }),
            onLog: (kind, message) => this.log(kind, message),
            onSettled: trade => {
                try {
                    this.opts.onSettled?.(trade);
                } catch {
                    /* a failed save must not stop trading */
                }
            },
        });
        this.log('info', 'AI auto-pilot started on the server');
        this.engine.start();
    }

    stop(reason = 'stopped by user') {
        if (this.engine?.isRunning) this.engine.stop(reason);
        else {
            this.patch({ status: 'stopped', stopReason: reason });
            this.finish();
        }
    }
}
