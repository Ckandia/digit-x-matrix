// Runs entirely in the browser, on the DerivClientConnection opened with the
// user's own session (see derivClient.ts). This is the "press AI and it does
// everything" engine: reads the account balance, derives stake/stop-loss/take-profit
// from a risk preset, picks the best available signal across every allowed contract
// family, and manages the stake with REVERSE martingale by default: the stake grows
// only on a winning streak and goes back to the base stake after any loss. After 2
// losses in a row it switches to a different contract instead of waiting for the market.
//
// The risk style (conservative / moderate / aggressive) changes STAKE NUMBERS ONLY.
// It is never an input to which market or contract is chosen: all three styles trade the
// same contracts. See RISK_PRESETS and the test that checks the candidate set is identical.
//
// Honesty note carried from the backend: every signal this consumes is a
// statistical deviation/momentum score on markets designed as fair random
// processes, not a validated edge — "confidence" describes how unusual
// something looks right now, not the odds of winning the trade.
import { DerivClientConnection } from './derivClient';
import { TDigitSignal, TSnapshotMap } from './analysis-types';
import { candidatesFromSnapshots, LearningEngine } from './learningEngine';
import { applyGate, isBlocked, TReviewGate } from '../journal/selfReview';
import { isMultiplierType, markRefused, MULTIPLIER_TICKS, tradeTicks } from './contractRules';
import { extraSignals, synthSignal, trendSideOf } from './aiContracts';
import { MULTIPLIER_TAKE_PROFIT_PCT, pickMultiplier, relativeBarrier, SPECS, SWITCH_PARTNER, specOf } from './contractSpecs';
import { TickTrendMonitor, trendLabel } from './trendFilter';

export type TRiskLevel = 'conservative' | 'moderate' | 'aggressive';

export type TRiskPreset = {
    stake_pct: number; // of balance, per trade at step 1
    streak_multiplier: number; // reverse martingale: stake growth per consecutive win
    max_streak: number; // reverse martingale: consecutive wins before the gain is banked and the stake resets
    martingale_multiplier: number; // classic modes only
    max_steps: number; // classic modes only
    stop_loss_pct: number; // of balance
    take_profit_pct: number; // of balance
};

export const RISK_PRESETS: Record<TRiskLevel, TRiskPreset> = {
    // Growth stays at or below a typical ~1.9x payout, so a streak stake is funded by what the streak has won.
    conservative: { stake_pct: 1, streak_multiplier: 1.5, max_streak: 3, martingale_multiplier: 1.8, max_steps: 4, stop_loss_pct: 10, take_profit_pct: 15 },
    moderate: { stake_pct: 2, streak_multiplier: 1.8, max_streak: 3, martingale_multiplier: 2.1, max_steps: 5, stop_loss_pct: 15, take_profit_pct: 20 },
    aggressive: { stake_pct: 3, streak_multiplier: 1.9, max_streak: 4, martingale_multiplier: 2.5, max_steps: 6, stop_loss_pct: 25, take_profit_pct: 30 },
};

/** How the stake behaves. 'reverse' (default) = reverse martingale: bigger stake after wins, base stake after a loss.
 *  Classic modes, which raise the stake after a LOSS: 'martingale' = same contract again, 'flip' = the opposite side.
 *  'flat' = same base stake always. */
export type TRecoveryMode = 'reverse' | 'martingale' | 'flip' | 'flat';

/** After this many losses in a row the AI switches to a different contract (does not wait for the market). */
export const SWITCH_AFTER_LOSSES = 2;

export type TAutoPilotConfig = {
    recovery_mode?: TRecoveryMode;
    stake: number;
    streak_multiplier?: number; // reverse mode; default 1.8
    max_streak?: number; // reverse mode; default 3
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
        recovery_mode: 'reverse',
        stake: Number(((balance * preset.stake_pct) / 100).toFixed(2)),
        streak_multiplier: preset.streak_multiplier,
        max_streak: preset.max_streak,
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
// Matches is dropped (too hard to program per the user) and Accumulators are deferred. Multipliers are
// open positions: they have no tick duration, close by themselves at +20% of the stake (a take-profit
// order sent with the buy) and are sold if the AI is stopped while one is open.
// Higher/Lower trade 5 ticks with a 0.1 barrier; Touch/No Touch trade 5 ticks with a 0.5 barrier.
const AUTOPILOT_CONTRACT_TYPES = [
    'DIGITEVEN',
    'DIGITODD',
    'OVER4',
    'UNDER5',
    'CALL',
    'PUT',
    'HIGHER',
    'LOWER',
    'MULTUP',
    'MULTDOWN',
    'RUNHIGH',
    'RUNLOW',
    'ONETOUCH',
    'NOTOUCH',
    'EXPIRYRANGE',
    'EXPIRYMISS',
    'RANGE',
    'UPORDOWN',
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
    RANGE: 'UPORDOWN',
    UPORDOWN: 'RANGE',
    ASIANU: 'ASIAND',
    ASIAND: 'ASIANU',
    TICKHIGH: 'TICKLOW',
    TICKLOW: 'TICKHIGH',
    RESETCALL: 'RESETPUT',
    RESETPUT: 'RESETCALL',
    OVER4: 'UNDER5',
    UNDER5: 'OVER4',
    HIGHER: 'LOWER',
    LOWER: 'HIGHER',
    MULTUP: 'MULTDOWN',
    MULTDOWN: 'MULTUP',
};

/** A quote whose payout is below this multiple of the stake is a guaranteed-loss trade: never buy it. */
const MIN_PAYOUT_RATIO = 1.05;
/** Deriv wording for "this contract itself is not available right now" (as opposed to balance/stake/connection errors). */
const REFUSAL_PATTERN = /not offered|duration|barrier|not available|unavailable|suspended|market is closed|no longer offered|selected tick/i;

export type TCandidate = TDigitSignal & {
    symbol: string;
    /** Multipliers only: the x to trade, once known. */
    multiplier?: number;
    /** Touch/No Touch only: trade this many ticks instead of 5 (Deriv refused 5 on this market). */
    ticks_override?: number;
};

const DEFAULT_MULTIPLIER = 100;
const round2 = (n: number) => Number(n.toFixed(2));
const isTouch = (type: string) => type === 'ONETOUCH' || type === 'NOTOUCH';

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

const NEEDS_SINGLE_BARRIER = new Set(['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER']);

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

    const type = candidate.contract_type;

    if (isMultiplierType(type)) {
        // An open position: no duration. Deriv closes it by itself once the profit reaches 20% of the stake.
        return {
            ...base,
            multiplier: candidate.multiplier ?? DEFAULT_MULTIPLIER,
            limit_order: { take_profit: round2(stake * MULTIPLIER_TAKE_PROFIT_PCT) },
        };
    }

    if (type === 'OVER4' || type === 'UNDER5') {
        // Digit Over/Under with the barrier fixed (Over 4 = digits 5-9, Under 5 = digits 0-4).
        return {
            ...base,
            contract_type: type === 'OVER4' ? 'DIGITOVER' : 'DIGITUNDER',
            duration: dutyTicks(candidate.symbol, type),
            duration_unit: 't',
            barrier: type === 'OVER4' ? '4' : '5',
        };
    }

    if (type === 'HIGHER' || type === 'LOWER') {
        // Deriv's CALL/PUT with a barrier: 5 ticks, 0.1 above (Higher) or below (Lower) the entry price.
        return {
            ...base,
            contract_type: type === 'HIGHER' ? 'CALL' : 'PUT',
            duration: dutyTicks(candidate.symbol, type),
            duration_unit: 't',
            barrier: relativeBarrier(specOf(type)),
        };
    }

    if (isTouch(type)) {
        // 5 ticks with a 0.5 barrier (10 ticks if Deriv refused 5, see _enter). The side of the barrier comes from the signal.
        const sign = String(candidate.prediction ?? '').trim().startsWith('-') ? '-' : '+';
        return {
            ...base,
            duration: candidate.ticks_override ?? dutyTicks(candidate.symbol, type),
            duration_unit: 't',
            barrier: `${sign}${SPECS.ONETOUCH.default_barrier_offset}`,
        };
    }

    if (candidate.contract_type === 'TICKHIGH' || candidate.contract_type === 'TICKLOW') {
        // High Tick/Low Tick is fixed at 5 ticks with a selected_tick 1-5.
        return { ...base, duration: 5, duration_unit: 't', selected_tick: Number(candidate.prediction) || 5 };
    }

    if (['EXPIRYRANGE', 'EXPIRYMISS', 'RANGE', 'UPORDOWN'].includes(candidate.contract_type)) {
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
    /** Every settled trade with the AI's own context, for the Journal tab and the AI's self-review. */
    onSettled?: (trade: TSettledTrade) => void;
    /** The AI's self-review of its past results: contracts it must skip and ones it ranks lower. Undefined = no gate. */
    gate?: () => TReviewGate | undefined;
};

export type TSettledTrade = {
    contract_id: string;
    symbol: string;
    contract_type: string;
    stake: number;
    profit: number;
    /** What came back: stake + profit. */
    payout: number;
    buy_ts: number;
    sell_ts: number;
    duration_ticks: number;
    /** Position on the stake ladder when the trade was placed. */
    step: number;
    base_stake: number;
    mode: TRecoveryMode;
    confidence: number;
    strategy?: string;
    tag?: 'flipped' | 'switched' | 'streak';
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
    /** Why this entry is not a plain fresh pick: opposite side (flip), a different contract after 2 losses, or a growing win streak. */
    tag?: 'flipped' | 'switched' | 'streak';
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
    private consecutive_losses = 0;
    private win_streak = 0; // reverse martingale: wins in a row
    private streak_profit = 0; // reverse martingale: what the current win streak has made
    private entry_tag: TAutoPilotEvent['tag']; // why the trade being placed is not a plain fresh pick
    private monitors = new Map<string, TickTrendMonitor>(); // 1-tick chart trend, per market
    private switch_pair: { origin: string; partner: string } | null = null; // the contract we switched away from, and to
    private touch_ticks: Record<string, number> = {}; // markets where Deriv refused 5 ticks for Touch/No Touch
    private multipliers: Record<string, number> = {}; // multiplier chosen per market
    private open_multiplier: string | null = null; // contract id of a multiplier that is still open

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
        this.consecutive_losses = 0;
        this.win_streak = 0;
        this.streak_profit = 0;
        this._emit({ phase: 'started' });
        this._findAndEnter(this.config.stake);
    }

    /** True from start() until stop(). The AI tab reads this to re-attach to a run that kept going while the tab was closed. */
    get isRunning() {
        return this.running;
    }

    stop(reason = 'stopped by user') {
        this.running = false;
        this.monitors.forEach(m => m.stop());
        this.monitors.clear();
        // A multiplier has no expiry: stopping the AI must close one that is still open.
        if (this.open_multiplier) {
            const contract_id = this.open_multiplier;
            this.open_multiplier = null;
            this.hooks?.onLog?.('info', `Closing the open multiplier ${contract_id}.`);
            this.connection
                .send({ sell: contract_id, price: 0 })
                .catch((err: Error) => this.hooks?.onLog?.('error', `Could not close multiplier ${contract_id}: ${err.message}`));
        }
        this._emit({ phase: 'stopped', reason });
    }

    /** Starts following the 1-tick chart of every market the AI can see (once each). */
    private _ensureMonitors(symbols: string[]) {
        for (const symbol of symbols) {
            if (this.monitors.has(symbol)) continue;
            const monitor = new TickTrendMonitor(this.connection, symbol);
            this.monitors.set(symbol, monitor);
            void monitor.start();
        }
    }

    /** Trend contracts are only allowed while their market's 1-tick chart shows the matching trend. */
    private _trendOk(symbol: string, contract_type: string): boolean {
        const side = trendSideOf(contract_type);
        return !side || this.monitors.get(symbol)?.trend() === side;
    }

    /** The backend's signals plus the AI's own (Over 4 / Under 5, Higher / Lower, Multipliers), minus any trend contract the chart does not back. */
    private _withExtras(snapshots: TSnapshotMap, skip?: Set<string>): TSnapshotMap {
        this._ensureMonitors(Object.keys(snapshots));
        const out: TSnapshotMap = {};
        for (const [symbol, snap] of Object.entries(snapshots)) {
            const signals = [...snap.signals, ...extraSignals(snap)].filter(
                sig => !skip?.has(sig.contract_type) && this._trendOk(symbol, sig.contract_type)
            );
            out[symbol] = { ...snap, signals };
        }
        return out;
    }

    private _emit(event: Partial<TAutoPilotEvent> & { phase: TAutoPilotEvent['phase'] }) {
        this.onEvent({
            ts: Date.now(),
            total_profit: this.total_profit,
            step: this.step,
            ...event,
        } as TAutoPilotEvent);
    }

    /** The best tradable contract right now (learner-guided when learning is on). Risk style plays no part in this. */
    private _pick(raw_snapshots: TSnapshotMap, skip?: Set<string>): TCandidate | null {
        // The AI's own signals are added first, then the self-review: skip contracts its own history proves are losing, rank lagging ones lower.
        const snapshots = applyGate(this._withExtras(raw_snapshots, skip), this.hooks?.gate?.());
        const learner = this.learner && this.learner.mode !== 'off' ? this.learner : undefined;
        return learner
            ? learner.pickBest(candidatesFromSnapshots<TDigitSignal>(snapshots, AUTOPILOT_CONTRACT_TYPES) as TCandidate[])
            : pickBestGlobalCandidate(snapshots);
    }

    /**
     * The contract a loss switches to, from the switch map: Even / No Touch / Fall / Lower <-> Over 4 and
     * Odd / Touch / Rise / Higher <-> Under 5. A contract we switched TO goes back to the one we left.
     * Null when the contract has no partner, or the partner cannot be traded right now (not offered, refused,
     * blocked by the self-review, or a trend contract whose trend is not confirmed): the caller then falls back.
     */
    private _partnerCandidate(lost: TCandidate): TCandidate | null {
        const pair = this.switch_pair;
        const back = pair && pair.partner === lost.contract_type;
        const target = back ? pair!.origin : SWITCH_PARTNER[lost.contract_type as keyof typeof SWITCH_PARTNER];
        if (!target || target === lost.contract_type) return null;
        const duration = tradeTicks(lost.symbol, target);
        if (duration === null || !this._trendOk(lost.symbol, target)) return null;
        const live = this.getSnapshots()[lost.symbol]?.signals.find(sig => sig.contract_type === target);
        const signal = live ?? synthSignal(target);
        if (!signal) return null;
        if (isBlocked(this.hooks?.gate?.(), lost.symbol, target, (signal as { strategy?: string }).strategy)) return null;
        if (!back) this.switch_pair = { origin: lost.contract_type, partner: target };
        return { symbol: lost.symbol, ...signal, duration_ticks: duration };
    }

    /** The contract to switch to after losses: the switch-map partner, else the best contract that is NOT the one that just lost (nor its opposite side). Null if there is none. */
    private _pickSwitch(lost: TCandidate): TCandidate | null {
        const partner = this._partnerCandidate(lost);
        if (partner) return partner;
        const skip = new Set(
            [lost.contract_type, FLIP_PARTNER[lost.contract_type], SWITCH_PARTNER[lost.contract_type as keyof typeof SWITCH_PARTNER]].filter(Boolean) as string[]
        );
        return this._pick(this.getSnapshots(), skip);
    }

    private _findAndEnter(stake: number, tag?: TAutoPilotEvent['tag']) {
        if (!this.running || this.busy) return;

        const learner = this.learner && this.learner.mode !== 'off' ? this.learner : undefined;
        const candidate = this._pick(this.getSnapshots());
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
            setTimeout(() => this._findAndEnter(stake, tag), 1500);
            return;
        }
        this._enter(candidate, stake, tag);
    }

    private _enter(candidate_in: TCandidate, wanted_stake: number, tag?: TAutoPilotEvent['tag']) {
        let candidate: TCandidate = candidate_in;
        // Touch/No Touch: once Deriv has refused 5 ticks on a market, go straight to 10 there.
        if (isTouch(candidate.contract_type) && !candidate.ticks_override && this.touch_ticks[candidate.symbol]) {
            candidate = { ...candidate, ticks_override: this.touch_ticks[candidate.symbol] };
        }
        // The small-stake exploration cap applies ONLY to the first trade of a ladder. It used to
        // clamp recovery steps too, which silently turned the martingale into a flat stake.
        const governed = this.learner && this.step === 1 ? this.learner.governStake(wanted_stake, this.config.stake, candidate) : wanted_stake;
        const stake = governed;
        if (governed < wanted_stake) {
            this.hooks?.onLog?.('info', `Exploring ${candidate.contract_type} ${candidate.duration_ticks ?? ''}t: first stake capped at ${governed} (25% of base) until 20 results are in.`);
        }
        // The connection keeps a LIVE balance (derivClient balance stream). Never buy a stake the
        // account cannot cover: Deriv would reject it, and a martingale step that big means the
        // ladder has run out of money, so stop the session instead of retrying.
        const live_balance = this.connection.accountInfo?.balance;
        if (typeof live_balance === 'number' && Number.isFinite(live_balance) && stake > live_balance) {
            this.hooks?.onLog?.('error', `The next stake (${stake} ${this.currency}) is more than the account balance (${live_balance.toFixed(2)}). Stopping.`);
            this.stop('balance is too low for the next stake');
            return;
        }
        if (this.step === 1) this.ladder_spent = 0;
        this.ladder_spent = Number((this.ladder_spent + stake).toFixed(2));
        this.busy = true;
        this.lastCandidate = candidate;
        this.entry_tag = tag;
        this._emit({
            phase: 'entering',
            symbol: candidate.symbol,
            contract_type: candidate.contract_type,
            label: candidate.label,
            confidence: candidate.confidence,
            stake,
            tag,
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
            setTimeout(() => this._findAndEnter(wanted_stake, tag), 500);
            return;
        }
        const is_multiplier = isMultiplierType(candidate.contract_type);
        const tried_duration = is_multiplier ? MULTIPLIER_TICKS : Number(parameters.duration);
        this.hooks?.onLog?.(
            'info',
            `Buying ${candidate.contract_type} on ${candidate.symbol}, ` +
                (is_multiplier ? 'closes at +20% of the stake' : `${tried_duration} tick(s)`) +
                `, stake ${stake} ${this.currency}` +
                (candidate.prediction !== undefined ? `, ${typeof candidate.prediction === 'string' ? 'barrier' : 'prediction'} ${candidate.prediction}` : '')
        );
        // Ask Deriv for a price first (the documented contracts_for -> proposal -> buy flow). A proposal
        // costs nothing, so a bad duration/barrier/stake is caught here instead of as a failed buy, and a
        // payout that cannot even cover the stake is never bought.
        // A multiplier needs its x first (what Deriv offers on this market, closest to 100x).
        const ready: Promise<unknown> = is_multiplier
            ? this._multiplierFor(candidate.symbol).then(x => {
                  parameters.multiplier = x;
              })
            : Promise.resolve();
        ready
            .then(() => this.connection.send({ proposal: 1, ...parameters }))
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
                // Touch/No Touch: Deriv refused 5 ticks on this market. Try 10 before giving the contract up.
                if (isTouch(candidate.contract_type) && tried_duration === 5 && !candidate.ticks_override && REFUSAL_PATTERN.test(raw) && this.running) {
                    this.touch_ticks[candidate.symbol] = 10;
                    this.hooks?.onLog?.('info', `${candidate.contract_type} on ${candidate.symbol} was refused at 5 ticks (${raw}); trying 10 ticks.`);
                    if (this.step === 1) this.ladder_spent = 0; else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
                    setTimeout(() => this.running && this._enter({ ...candidate, ticks_override: 10 }, wanted_stake, tag), 300);
                    return;
                }
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
                    setTimeout(() => this._findAndEnter(wanted_stake, tag), 500);
                    return;
                }
                this._emit({ phase: 'error', symbol: candidate.symbol, error: detail });
                this.stop('trade placement failed');
            });
    }

    /** The multiplier (x) to use on a market: of the values Deriv offers, the one closest to 100x. */
    private async _multiplierFor(symbol: string): Promise<number> {
        if (this.multipliers[symbol]) return this.multipliers[symbol];
        let chosen = DEFAULT_MULTIPLIER;
        try {
            chosen = pickMultiplier(await this.connection.send({ contracts_for: symbol, currency: this.currency })) ?? DEFAULT_MULTIPLIER;
        } catch {
            /* keep the default: Deriv will say if it is not allowed */
        }
        this.multipliers[symbol] = chosen;
        return chosen;
    }

    private _watch(candidate: TCandidate, stake: number, contract_id: string, duration: number) {
        const entry_step = this.step;
        const entry_tag = this.entry_tag;
        if (isMultiplierType(candidate.contract_type)) this.open_multiplier = String(contract_id);
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
            if (this.open_multiplier === String(contract_id)) this.open_multiplier = null;
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

            const bought = Number(contract.buy_price ?? stake);
            const now = Date.now();
            this.hooks?.onSettled?.({
                contract_id: String(contract_id),
                symbol: candidate.symbol,
                contract_type: candidate.contract_type,
                stake: bought,
                profit: Number(profit.toFixed(2)),
                payout: Number((bought + profit).toFixed(2)),
                buy_ts: Number(contract.date_start ?? contract.purchase_time ?? 0) * 1000 || now,
                sell_ts: Number(contract.sell_time ?? contract.date_expiry ?? 0) * 1000 || now,
                duration_ticks: duration,
                step: entry_step,
                base_stake: this.config.stake,
                mode: this.config.recovery_mode ?? 'reverse',
                confidence: candidate.confidence,
                strategy: (candidate as { strategy?: string }).strategy,
                tag: entry_tag,
            });

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

            const mode = this.config.recovery_mode ?? 'reverse';
            const base_stake = this.config.stake;

            if (won) {
                this.consecutive_losses = 0;
                this.switch_pair = null; // a win ends the loss run: the next loss starts a fresh switch
                if (mode !== 'reverse') {
                    this.step = 1;
                    this._findAndEnter(base_stake);
                    return;
                }
                // Reverse martingale: the stake grows only after a win, and only by what the streak has won.
                this.win_streak += 1;
                this.streak_profit = Number((this.streak_profit + profit).toFixed(2));
                const max_streak = Math.max(1, Math.floor(this.config.max_streak ?? 3));
                if (this.win_streak >= max_streak) {
                    this.hooks?.onLog?.('success', `${this.win_streak} wins in a row: gain banked, stake goes back to ${base_stake}.`);
                    this.win_streak = 0;
                    this.streak_profit = 0;
                    this.step = 1;
                    this._findAndEnter(base_stake);
                    return;
                }
                const growth = Math.max(1, this.config.streak_multiplier ?? 1.8);
                // Never risk more than the base stake plus what this streak has already won.
                const next_stake = Number(Math.max(base_stake, Math.min(stake * growth, base_stake + this.streak_profit)).toFixed(2));
                this.step = this.win_streak + 1;
                this._findAndEnter(next_stake, 'streak');
                return;
            }

            // ---- a loss ----
            this.win_streak = 0;
            this.streak_profit = 0;
            this.consecutive_losses += 1;
            const must_switch = this.consecutive_losses >= SWITCH_AFTER_LOSSES;
            if (must_switch) this.consecutive_losses = 0; // re-arm: the next switch is after 2 more losses

            // Switch to a different contract right now, instead of waiting for the market to turn.
            const switchTo = (next_stake: number): boolean => {
                if (!must_switch) return false;
                const alt = this._pickSwitch(candidate);
                if (!alt) {
                    this.hooks?.onLog?.('info', `${SWITCH_AFTER_LOSSES} losses in a row on ${candidate.contract_type}, but no other contract is tradable right now.`);
                    return false;
                }
                this.hooks?.onLog?.('info', `${SWITCH_AFTER_LOSSES} losses in a row on ${candidate.contract_type}: switching to ${alt.contract_type} on ${alt.symbol}.`);
                this._enter(alt, next_stake, 'switched');
                return true;
            };

            if (mode === 'reverse' || mode === 'flat') {
                // The stake does NOT go up after a loss: back to the base stake.
                this.step = 1;
                if (switchTo(base_stake)) return;
                this._findAndEnter(base_stake);
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
            if (switchTo(next_stake)) return;
            if (mode === 'martingale') {
                this._enter(candidate, next_stake); // same contract, same side, bigger stake
                return;
            }
            const flip = this._partnerCandidate(candidate) ?? pickFlipCandidate(this.getSnapshots(), candidate.symbol, candidate);
            if (isBlocked(this.hooks?.gate?.(), flip.symbol, flip.contract_type, (flip as { strategy?: string }).strategy)) {
                this.hooks?.onLog?.('info', `The opposite side (${flip.contract_type}) is skipped: its own results are clearly negative. Picking another contract.`);
                this._findAndEnter(next_stake);
                return;
            }
            this._enter(flip, next_stake, 'flipped');
        });
    }
}
