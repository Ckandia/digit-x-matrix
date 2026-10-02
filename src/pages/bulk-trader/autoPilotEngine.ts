// Runs entirely in the browser, on the DerivClientConnection opened with the
// user's own session (see derivClient.ts). This is the "press AI and it does
// everything" engine: reads the account balance, derives stake/martingale/
// stop-loss/take-profit from a risk preset, picks the best available signal
// across every allowed contract family, and on a loss flips to that family's
// opposite side (escalating stake) until it recovers or hits the step ceiling.
//
// Honesty note carried from the backend: every signal this consumes is a
// statistical deviation/momentum score on markets designed as fair random
// processes, not a validated edge — "confidence" describes how unusual
// something looks right now, not the odds of winning the trade.
import { DerivClientConnection } from './derivClient';
import { TDigitSignal, TSnapshotMap } from './analysis-types';
import { candidatesFromSnapshots, LearningEngine } from './learningEngine';
import { markRefused, tradeTicks } from './contractRules';

export type TRiskLevel = 'conservative' | 'moderate' | 'aggressive';

export type TRiskPreset = {
    stake_pct: number; // of balance, per trade at step 1
    martingale_multiplier: number;
    max_steps: number;
    stop_loss_pct: number; // of balance
    take_profit_pct: number; // of balance
};

export const RISK_PRESETS: Record<TRiskLevel, TRiskPreset> = {
    conservative: { stake_pct: 1, martingale_multiplier: 1.8, max_steps: 4, stop_loss_pct: 10, take_profit_pct: 15 },
    moderate: { stake_pct: 2, martingale_multiplier: 2.1, max_steps: 5, stop_loss_pct: 15, take_profit_pct: 20 },
    aggressive: { stake_pct: 3, martingale_multiplier: 2.5, max_steps: 6, stop_loss_pct: 25, take_profit_pct: 30 },
};

/** What happens after a loss: 'martingale' = same contract again with a bigger stake, 'flip' = the opposite side with a bigger stake, 'flat' = same base stake, no recovery. */
export type TRecoveryMode = 'martingale' | 'flip' | 'flat';

export type TAutoPilotConfig = {
    recovery_mode?: TRecoveryMode;
    stake: number;
    martingale_multiplier: number;
    max_steps: number;
    stop_loss: number; // absolute currency amount, anchored to balance at start
    take_profit: number; // absolute currency amount, anchored to balance at start
};

/** Turns a risk preset + live balance into the absolute numbers shown/edited
 *  in the UI. Editing a field in the UI just overwrites one of these — the
 *  preset is only ever a starting point, never enforced afterward. */
export const buildConfigFromPreset = (level: TRiskLevel, balance: number): TAutoPilotConfig => {
    const preset = RISK_PRESETS[level];
    return {
        recovery_mode: 'martingale',
        stake: Number(((balance * preset.stake_pct) / 100).toFixed(2)),
        martingale_multiplier: preset.martingale_multiplier,
        max_steps: preset.max_steps,
        stop_loss: Number(((balance * preset.stop_loss_pct) / 100).toFixed(2)),
        take_profit: Number(((balance * preset.take_profit_pct) / 100).toFixed(2)),
    };
};

// Duration rule (see contractRules.tradeTicks): every contract is traded for exactly 1 tick,
// except the barrier contracts (Touch/No Touch, Ends Between/Outside), which use the shortest
// duration Deriv offers. Contracts Deriv does not sell at 1 tick (Asians, Only Ups/Downs,
// High/Low Tick, Reset) stay in this list but are filtered out by tradeTicks() === null, so
// they are never bought, instead of being rejected by Deriv or stretched past 1 tick.
//
// The 8 contract families in this pass — Matches dropped (too hard to
// program per the user), Multiplier and Accumulators deferred (they're
// open-position contracts needing a different execution/monitoring model
// than every fixed-duration contract here).
const AUTOPILOT_CONTRACT_TYPES = [
    'DIGITEVEN',
    'DIGITODD',
    'CALL',
    'PUT',
    'RUNHIGH',
    'RUNLOW',
    'ONETOUCH',
    'NOTOUCH',
    'EXPIRYRANGE',
    'EXPIRYMISS',
    'ASIANU',
    'ASIAND',
    'TICKHIGH',
    'TICKLOW',
    'RESETCALL',
    'RESETPUT',
] as const;

/** Every family here has a natural opposite side — flipping alternates
 *  between them on each martingale recovery step. */
const FLIP_PARTNER: Record<string, string> = {
    DIGITEVEN: 'DIGITODD',
    DIGITODD: 'DIGITEVEN',
    CALL: 'PUT',
    PUT: 'CALL',
    RUNHIGH: 'RUNLOW',
    RUNLOW: 'RUNHIGH',
    ONETOUCH: 'NOTOUCH',
    NOTOUCH: 'ONETOUCH',
    EXPIRYRANGE: 'EXPIRYMISS',
    EXPIRYMISS: 'EXPIRYRANGE',
    ASIANU: 'ASIAND',
    ASIAND: 'ASIANU',
    TICKHIGH: 'TICKLOW',
    TICKLOW: 'TICKHIGH',
    RESETCALL: 'RESETPUT',
    RESETPUT: 'RESETCALL',
};

/** A quote whose payout is below this multiple of the stake is a guaranteed-loss trade: never buy it. */
const MIN_PAYOUT_RATIO = 1.05;
/** Deriv wording for "this contract itself is not available right now" (as opposed to balance/stake/connection errors). */
const REFUSAL_PATTERN = /not offered|duration|barrier|not available|unavailable|suspended|market is closed|no longer offered|selected tick/i;

export type TCandidate = TDigitSignal & { symbol: string };

/** Best-confidence signal across every symbol, restricted to the families the
 *  auto-pilot is allowed to trade. Used for the very first entry, and again
 *  after every win (the ladder resets and re-scans from scratch). */
export const pickBestGlobalCandidate = (snapshots: TSnapshotMap): TCandidate | null => {
    let best: TCandidate | null = null;
    for (const [symbol, snapshot] of Object.entries(snapshots)) {
        for (const signal of snapshot.signals) {
            if (!AUTOPILOT_CONTRACT_TYPES.includes(signal.contract_type as (typeof AUTOPILOT_CONTRACT_TYPES)[number]))
                continue;
            const ticks = tradeTicks(symbol, signal.contract_type);
            if (ticks === null) continue; // not offered at 1 tick (or not in ticks at all): never traded
            if (!best || signal.confidence > best.confidence) best = { symbol, ...signal, duration_ticks: ticks };
        }
    }
    return best;
};

/** The flip candidate for a recovery step: same symbol, the opposite side of
 *  whatever just lost. Prefers a live signal for that side (so duration is
 *  freshly AI-picked, per the design); falls back to a synthetic same-duration
 *  entry if the analysis doesn't currently have one for that exact side —
 *  recovery must always be able to fire, even when the flipped side isn't
 *  independently "in favour" right now. */
export const pickFlipCandidate = (snapshots: TSnapshotMap, symbol: string, previous: TCandidate): TCandidate => {
    const flip_type = FLIP_PARTNER[previous.contract_type];
    const snapshot = snapshots[symbol];
    const live = snapshot?.signals.find(s => s.contract_type === flip_type);
    const flip_ticks = tradeTicks(symbol, flip_type) ?? undefined;
    if (live) return { symbol, ...live, duration_ticks: flip_ticks };

    return {
        symbol,
        family: previous.family,
        contract_type: flip_type as TDigitSignal['contract_type'],
        duration_ticks: flip_ticks,
        prediction: flipPrediction(previous),
        label: `${previous.label} (flipped)`,
        confidence: 0,
        basis: 'No live signal for this side yet — flipping anyway to continue the recovery ladder.',
    };
};

/** Barrier/selection carries over sensibly across a flip: Touch/No Touch and
 *  Ends Between/Outside keep the same barrier distance; High/Low Tick flips
 *  which tick (5th <-> 1st) is selected; digit barriers (5) don't change. */
const flipPrediction = (previous: TCandidate): TDigitSignal['prediction'] => {
    if (previous.contract_type === 'TICKHIGH' || previous.contract_type === 'TICKLOW') {
        return previous.prediction === 5 ? 1 : 5;
    }
    return previous.prediction;
};

const NEEDS_SINGLE_BARRIER = new Set(['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER', 'ONETOUCH', 'NOTOUCH']);

/** The duration to send to Deriv. Throws if this contract may not be traded (see tradeTicks). */
const dutyTicks = (symbol: string, contract_type: string): number => {
    const ticks = tradeTicks(symbol, contract_type);
    if (ticks === null) throw new Error(`${contract_type} on ${symbol} is not offered at 1 tick (or is temporarily refused)`);
    return ticks;
};

/** Builds Deriv `buy` parameters for any of the families this engine trades. */
export const buildTradeParameters = (candidate: TCandidate, stake: number, currency: string) => {
    const base: Record<string, unknown> = {
        amount: stake,
        basis: 'stake',
        contract_type: candidate.contract_type,
        currency,
        underlying_symbol: candidate.symbol,
    };

    if (candidate.contract_type === 'TICKHIGH' || candidate.contract_type === 'TICKLOW') {
        // High Tick/Low Tick is fixed at 5 ticks with a selected_tick 1-5.
        return { ...base, duration: 5, duration_unit: 't', selected_tick: Number(candidate.prediction) || 5 };
    }

    if (candidate.contract_type === 'EXPIRYRANGE' || candidate.contract_type === 'EXPIRYMISS') {
        const offset = Math.abs(Number(candidate.prediction) || 0);
        return {
            ...base,
            duration: dutyTicks(candidate.symbol, candidate.contract_type),
            duration_unit: 't',
            barrier: `+${offset}`,
            barrier2: `-${offset}`,
        };
    }

    const parameters: Record<string, unknown> = {
        ...base,
        duration: dutyTicks(candidate.symbol, candidate.contract_type),
        duration_unit: 't',
    };
    if (NEEDS_SINGLE_BARRIER.has(candidate.contract_type)) {
        parameters.barrier = String(candidate.prediction);
    }
    return parameters;
};

export type TAutoPilotHooks = {
    /** Every proposal_open_contract update, in Deriv's own shape (for the Transactions/Summary tabs). */
    onContract?: (contract: Record<string, unknown>) => void;
    /** Human-readable lines for the Journal tab. */
    onLog?: (kind: 'info' | 'success' | 'error', message: string) => void;
};

export type TAutoPilotEvent = {
    ts: number;
    phase: 'started' | 'entering' | 'settled' | 'stopped' | 'error' | 'waiting';
    step?: number;
    symbol?: string;
    contract_type?: string;
    label?: string;
    confidence?: number;
    stake?: number;
    result?: 'win' | 'loss';
    profit?: number;
    total_profit?: number;
    reason?: string;
    error?: string;
};

export class AutoPilotEngine {
    private connection: DerivClientConnection;
    private currency: string;
    private getSnapshots: () => TSnapshotMap;
    private onEvent: (event: TAutoPilotEvent) => void;

    private config: TAutoPilotConfig;
    private step = 1;
    private total_profit = 0;
    private running = false;
    private busy = false;
    private lastCandidate: TCandidate | null = null;
    private learner?: LearningEngine;
    private hooks?: TAutoPilotHooks;
    private refused = 0;
    private ladder_spent = 0;
    private last_wait_emit = 0;

    constructor(
        connection: DerivClientConnection,
        currency: string,
        config: TAutoPilotConfig,
        getSnapshots: () => TSnapshotMap,
        onEvent: (event: TAutoPilotEvent) => void,
        learner?: LearningEngine,
        hooks?: TAutoPilotHooks
    ) {
        this.learner = learner;
        this.hooks = hooks;
        this.connection = connection;
        this.currency = currency;
        this.config = config;
        this.getSnapshots = getSnapshots;
        this.onEvent = onEvent;
        this.connection.onFatalError = () => this._emit({ phase: 'error', error: 'Lost connection to Deriv' });
        this.connection.onReconnecting = () => this.hooks?.onLog?.('info', 'Connection to Deriv dropped; reconnecting...');
        this.connection.onReconnect = () =>
            this.hooks?.onLog?.('success', 'Reconnected to Deriv. Any open contract is being re-checked.');
    }

    start() {
        this.running = true;
        this.step = 1;
        this.total_profit = 0;
        this._emit({ phase: 'started' });
        this._findAndEnter(this.config.stake);
    }

    stop(reason = 'stopped by user') {
        this.running = false;
        this._emit({ phase: 'stopped', reason });
    }

    private _emit(event: Partial<TAutoPilotEvent> & { phase: TAutoPilotEvent['phase'] }) {
        this.onEvent({
            ts: Date.now(),
            total_profit: this.total_profit,
            step: this.step,
            ...event,
        } as TAutoPilotEvent);
    }

    private _findAndEnter(stake: number) {
        if (!this.running || this.busy) return;

        const learner = this.learner && this.learner.mode !== 'off' ? this.learner : undefined;
        const candidate = learner
            ? learner.pickBest(candidatesFromSnapshots<TDigitSignal>(this.getSnapshots(), AUTOPILOT_CONTRACT_TYPES) as TCandidate[])
            : pickBestGlobalCandidate(this.getSnapshots());
        if (!candidate) {
            if (Date.now() - this.last_wait_emit > 30_000) {
                this.last_wait_emit = Date.now();
                this._emit({
                    phase: 'waiting',
                    reason:
                        learner?.mode === 'edge_gate'
                            ? 'no market/contract has a proven edge yet'
                            : 'no market has a tradable 1-tick signal right now (contracts Deriv refused or priced too low are skipped)',
                });
            }
            // Nothing meets the bar right now — try again shortly rather than
            // erroring out; live signals come and go every second.
            setTimeout(() => this._findAndEnter(stake), 1500);
            return;
        }
        this._enter(candidate, stake);
    }

    private _enter(candidate_in: TCandidate, wanted_stake: number) {
        const candidate: TCandidate = candidate_in;
        // The small-stake exploration cap applies ONLY to the first trade of a ladder. It used to
        // clamp recovery steps too, which silently turned the martingale into a flat stake.
        const governed = this.learner && this.step === 1 ? this.learner.governStake(wanted_stake, this.config.stake, candidate) : wanted_stake;
        const stake = governed;
        if (governed < wanted_stake) {
            this.hooks?.onLog?.('info', `Exploring ${candidate.contract_type} ${candidate.duration_ticks ?? ''}t: first stake capped at ${governed} (25% of base) until 20 results are in.`);
        }
        if (this.step === 1) this.ladder_spent = 0;
        this.ladder_spent = Number((this.ladder_spent + stake).toFixed(2));
        this.busy = true;
        this.lastCandidate = candidate;
        this._emit({
            phase: 'entering',
            symbol: candidate.symbol,
            contract_type: candidate.contract_type,
            label: candidate.label,
            confidence: candidate.confidence,
            stake,
        });

        let parameters: Record<string, unknown>;
        try {
            parameters = buildTradeParameters(candidate, stake, this.currency);
        } catch (err) {
            // Nothing was sent to Deriv, so nothing can be lost: look for another contract.
            this.busy = false;
            const detail = err instanceof Error ? err.message : 'Could not build the trade';
            this.hooks?.onLog?.('error', detail);
            markRefused(candidate.symbol, candidate.contract_type);
            if (this.step === 1) this.ladder_spent = 0; else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
            setTimeout(() => this._findAndEnter(wanted_stake), 500);
            return;
        }
        const tried_duration = Number(parameters.duration);
        this.hooks?.onLog?.(
            'info',
            `Buying ${candidate.contract_type} on ${candidate.symbol}, ${tried_duration} tick(s), stake ${stake} ${this.currency}` +
                (candidate.prediction !== undefined ? `, prediction ${candidate.prediction}` : '')
        );
        // Ask Deriv for a price first (the documented contracts_for -> proposal -> buy flow). A proposal
        // costs nothing, so a bad duration/barrier/stake is caught here instead of as a failed buy, and a
        // payout that cannot even cover the stake is never bought.
        this.connection
            .send({ proposal: 1, ...parameters })
            .then(res => {
                const quote = res?.proposal;
                if (!quote) throw new Error('Deriv returned no price for this contract');
                const ask = Number(quote.ask_price);
                const payout = Number(quote.payout);
                if (ask > 0 && payout > 0 && payout / ask < MIN_PAYOUT_RATIO) {
                    throw Object.assign(new Error(`payout is only ${(payout / ask).toFixed(2)}x the stake`), { skip: true });
                }
                return this.connection.send({ buy: '1', price: stake, parameters });
            })
            .then(res => {
                const contract_id = res?.buy?.contract_id;
                if (!contract_id) throw new Error('Buy did not return a contract id');
                this._watch(candidate, stake, contract_id, tried_duration);
            })
            .catch(err => {
                this.busy = false;
                const raw = String(err?.message || 'Failed to place trade');
                if (/dropped/i.test(raw)) this.hooks?.onLog?.('error', 'The connection dropped while buying. Check Transactions: that contract may still be open.');
                const detail = `${candidate.contract_type} on ${candidate.symbol} for ${tried_duration} tick(s): ${raw}`;
                this.hooks?.onLog?.('error', detail);
                // A refusal about this contract itself (duration, barrier, market closed, low payout): skip
                // the combination for 6 hours and search again. Anything else (balance, stake limits, a
                // dropped connection) stops the session so it cannot keep failing or trading blind.
                if ((err?.skip === true || REFUSAL_PATTERN.test(raw)) && this.refused < 8) {
                    this.refused += 1;
                    markRefused(candidate.symbol, candidate.contract_type);
                    this.hooks?.onLog?.('info', `Skipping ${candidate.symbol} ${candidate.contract_type} for 6 hours and trying another.`);
                    if (this.step === 1) this.ladder_spent = 0; else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
                    // Search again. (Before this, the engine marked the combination and then went idle.)
                    setTimeout(() => this._findAndEnter(wanted_stake), 500);
                    return;
                }
                this._emit({ phase: 'error', symbol: candidate.symbol, error: detail });
                this.stop('trade placement failed');
            });
    }

    private _watch(candidate: TCandidate, stake: number, contract_id: string, duration: number) {
        const sub_id = this.connection.subscribe({ proposal_open_contract: 1, contract_id }, (data, err) => {
            if (err) {
                this.busy = false;
                this._emit({ phase: 'error', symbol: candidate.symbol, error: err.message });
                this.stop('lost track of an open contract');
                return;
            }
            const contract = data?.proposal_open_contract;
            if (contract) this.hooks?.onContract?.(contract);
            if (!contract?.is_sold) return;
            this.refused = 0;

            this.connection.unsubscribe(sub_id);
            const profit = Number(contract.profit ?? 0);
            const won = profit > 0;
            this.hooks?.onLog?.(won ? 'success' : 'error', `${won ? 'Won' : 'Lost'} ${Math.abs(profit).toFixed(2)} ${this.currency} on ${candidate.symbol} ${candidate.contract_type}`);
            if (this.learner && this.learner.mode !== 'off') {
                this.learner.record({
                    symbol: candidate.symbol,
                    contract_type: candidate.contract_type + ((candidate as { bucket?: string }).bucket ? `@${(candidate as { bucket?: string }).bucket}` : ''),
                    duration,
                    stake: Number(contract.buy_price ?? stake),
                    profit,
                    payout: Number(contract.payout ?? 0),
                });
            }
            this.total_profit = Number((this.total_profit + profit).toFixed(2));

            this._emit({
                phase: 'settled',
                symbol: candidate.symbol,
                contract_type: candidate.contract_type,
                result: won ? 'win' : 'loss',
                profit: Number(profit.toFixed(2)),
            });

            this.busy = false;
            if (!this.running) return;

            if (this.total_profit <= -Math.abs(this.config.stop_loss)) {
                this.stop('stop loss reached');
                return;
            }
            if (this.total_profit >= this.config.take_profit) {
                this.stop('take profit reached');
                return;
            }

            if (won) {
                this.step = 1;
                this._findAndEnter(this.config.stake);
                return;
            }

            const mode = this.config.recovery_mode ?? 'flip';
            if (mode === 'flat') {
                // No recovery: keep the base stake; only the take-profit / stop-loss end the session.
                this.step = 1;
                this._findAndEnter(this.config.stake);
                return;
            }

            if (this.step >= this.config.max_steps) {
                this.stop('max recovery steps reached');
                return;
            }

            const next_stake = Number((stake * this.config.martingale_multiplier).toFixed(2));
            // Ladder budget: the whole recovery run may risk at most stop_loss in total.
            if (this.ladder_spent + next_stake > Math.abs(this.config.stop_loss)) {
                this.stop('recovery ladder would exceed the stop-loss budget');
                return;
            }
            this.step += 1;
            if (mode === 'martingale') {
                this._enter(candidate, next_stake); // same contract, same side, bigger stake
                return;
            }
            const flip = pickFlipCandidate(this.getSnapshots(), candidate.symbol, candidate);
            this._enter(flip, next_stake);
        });
    }
}
