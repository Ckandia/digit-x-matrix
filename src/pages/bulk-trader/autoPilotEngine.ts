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
import { markRefused, tradeTicks } from './contractRules';
import { detectTrend, TREND_WINDOW } from './trendFilter';

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
    /** After a loss, switch to the partner contract (Even<->Over 4 ...); after the next loss, back. Off when undefined/false. */
    auto_flip?: boolean;
    /** Capital protection: for the first N trades of a run the stake stays at the base stake (no growth) and a tight early loss limit applies. 0/undefined = off. */
    protect_trades?: number;
    /** Virtual hook: after a real loss, trade on paper (no money) until a paper trade wins, then resume real trading. */
    virtual_hook?: boolean;
};

/** The early loss limit during capital protection, in base stakes. */
export const PROTECT_LOSS_STAKES = 3;
export const DEFAULT_PROTECT_TRADES = 10;

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
        auto_flip: true,
        protect_trades: DEFAULT_PROTECT_TRADES,
        virtual_hook: true,
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
    'DIGITOVER', // Over 4
    'DIGITUNDER', // Under 5
    'CALL',
    'PUT',
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
    DIGITOVER: 'DIGITUNDER',
    DIGITUNDER: 'DIGITOVER',
};

/** Over 4 / Under 5 are digit contracts with a fixed barrier; this is the key the switch table uses for them. */
const switchKey = (c: { contract_type: string; prediction?: number | string }): string =>
    c.contract_type === 'DIGITOVER' ? 'OVER4' : c.contract_type === 'DIGITUNDER' ? 'UNDER5' : c.contract_type;

/**
 * Auto flip (the owner's pairs). After a loss a contract switches with its partner, after the next loss it goes back:
 *   Even <-> Over 4    Odd <-> Under 5    Touch <-> Under 5    No Touch <-> Over 4
 *   Rise <-> Under 5   Fall <-> Over 4    (Over 4 <-> Under 5 with each other)
 * Higher/Lower and Multipliers have the same pairs but are only on the Bulk Trades tab (they are not 1-tick contracts).
 * Contracts not listed here keep the normal behaviour.
 */
export const SWITCH_PARTNER_KEY: Record<string, 'OVER4' | 'UNDER5'> = {
    DIGITEVEN: 'OVER4',
    DIGITODD: 'UNDER5',
    ONETOUCH: 'UNDER5',
    NOTOUCH: 'OVER4',
    CALL: 'UNDER5',
    PUT: 'OVER4',
    OVER4: 'UNDER5',
    UNDER5: 'OVER4',
};

export const partnerCandidate = (symbol: string, from: TCandidate): TCandidate | null => {
    // Contracts without a listed pair (Asians, Runs, Ranges ...) also switch after one loss: to Under 5.
    const key = SWITCH_PARTNER_KEY[switchKey(from)] ?? 'UNDER5';
    const over = key === 'OVER4';
    return {
        symbol,
        family: 'digits',
        contract_type: over ? 'DIGITOVER' : 'DIGITUNDER',
        prediction: over ? 4 : 5,
        duration_ticks: 1,
        label: over ? 'Over 4' : 'Under 5',
        confidence: 0,
        basis: `Auto flip: ${from.label} lost, switching to ${over ? 'Over 4' : 'Under 5'}.`,
    } as TCandidate;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Contracts the virtual hook can settle from live ticks. Others are only ever traded for real. */
export const PAPER_SUPPORTED = new Set(['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'CALL', 'PUT', 'ONETOUCH', 'NOTOUCH']);

/**
 * Settles a paper (virtual) trade the way Deriv would. `entry` is the first tick after the virtual buy and `after` the
 * ticks that followed it. Returns true = win, false = loss, null = not enough ticks yet.
 * 1-tick contracts settle on the first tick after entry; Touch / No Touch run for `needed` ticks (touch ends it early).
 */
export const paperOutcome = (type: string, entry: number, after: number[], pip: number, needed = 1): boolean | null => {
    if (isTouch(type)) {
        const touched = after.slice(0, needed).some(q => q >= entry + 0.5);
        if (touched) return type === 'ONETOUCH';
        return after.length >= needed ? type === 'NOTOUCH' : null;
    }
    if (after.length < 1) return null;
    const exit = after[0];
    const digit = Number(exit.toFixed(pip).slice(-1));
    switch (type) {
        case 'DIGITEVEN':
            return digit % 2 === 0;
        case 'DIGITODD':
            return digit % 2 === 1;
        case 'DIGITOVER':
            return digit > 4;
        case 'DIGITUNDER':
            return digit < 5;
        case 'CALL':
            return exit > entry;
        case 'PUT':
            return exit < entry;
        default:
            return null;
    }
};

/** Contracts that wait for a confirmed trend on the 1-tick chart: Rise needs a higher high, Fall a lower low. */
const TREND_NEEDED: Record<string, 'bullish' | 'bearish'> = { CALL: 'bullish', PUT: 'bearish' };

/**
 * The owner wants quick 1-tick contracts, not ones that sit open. When any market has a tradable 1-tick signal,
 * every longer contract (the barrier ones) is left out of the ranking; they are used only when nothing 1-tick exists.
 */
export const preferOneTick = (snapshots: TSnapshotMap): TSnapshotMap => {
    const has_one_tick = Object.entries(snapshots).some(([symbol, snap]) =>
        snap.signals.some(sig => tradeTicks(symbol, sig.contract_type) === 1)
    );
    if (!has_one_tick) return snapshots;
    const out: TSnapshotMap = {};
    for (const [symbol, snap] of Object.entries(snapshots)) {
        out[symbol] = { ...snap, signals: snap.signals.filter(sig => tradeTicks(symbol, sig.contract_type) === 1) };
    }
    return out;
};

/** A quote whose payout is below this multiple of the stake is a guaranteed-loss trade: never buy it. */
const MIN_PAYOUT_RATIO = 1.05;
/** Deriv wording for "this contract itself is not available right now" (as opposed to balance/stake/connection errors). */
const REFUSAL_PATTERN = /not offered|duration|barrier|not available|unavailable|suspended|market is closed|no longer offered|selected tick/i;

export type TCandidate = TDigitSignal & { symbol: string };

/** Best-confidence signal across every symbol, restricted to the families the
 *  auto-pilot is allowed to trade. Used for the very first entry, and again
 *  after every win (the ladder resets and re-scans from scratch). */
export const pickBestGlobalCandidate = (all_snapshots: TSnapshotMap): TCandidate | null => {
    let best: TCandidate | null = null;
    const snapshots = preferOneTick(all_snapshots);
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
const touch_ticks = new Map<string, number>(); // symbol|type -> 10 once Deriv refused 5 ticks for it
const isTouch = (t: string) => t === 'ONETOUCH' || t === 'NOTOUCH';
const TOUCH_BARRIER = '+0.5';
const dutyTicks = (symbol: string, contract_type: string): number => {
    const ticks = tradeTicks(symbol, contract_type);
    if (ticks === null) throw new Error(`${contract_type} on ${symbol} is not offered at 1 tick (or is temporarily refused)`);
    // Touch / No Touch: 5 ticks with a 0.5 barrier, or 10 ticks with 0.5 if Deriv refuses 5 on this market.
    if (isTouch(contract_type)) return touch_ticks.get(`${symbol}|${contract_type}`) ?? 5;
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
    if (isTouch(candidate.contract_type)) {
        parameters.barrier = TOUCH_BARRIER;
    } else if (candidate.contract_type === 'DIGITOVER') {
        parameters.barrier = '4'; // Over 4
    } else if (candidate.contract_type === 'DIGITUNDER') {
        parameters.barrier = '5'; // Under 5
    } else if (NEEDS_SINGLE_BARRIER.has(candidate.contract_type)) {
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
    phase: 'started' | 'entering' | 'settled' | 'stopped' | 'error' | 'waiting' | 'virtual';
    /** For phase 'virtual': the hook paused real trading ('start'), is about to paper trade ('paper'), settled one ('result'), or resumed real trading ('end'). */
    virtual_state?: 'start' | 'paper' | 'result' | 'end';
    virtual_losses?: number;
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
    private hook_pending = false; // a real loss just happened: the next entry is paper-traded first (virtual hook)
    private trade_count = 0; // settled trades in this run (capital protection counts these)
    private flip_origin: TCandidate | null = null; // auto flip: the contract we flipped away from
    private blocked = new Map<string, number>(); // symbol|type -> until: no trend confirmed on the 1-tick chart yet

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
        this.busy = false;
        this.trade_count = 0;
        this.hook_pending = false;
        this.flip_origin = null;
        this.blocked.clear();
        this._emit({ phase: 'started' });
        this._findAndEnter(this.config.stake);
    }

    /** True from start() until stop(). The AI tab reads this to re-attach to a run that kept going while the tab was closed. */
    get isRunning() {
        return this.running;
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

    /** The best tradable contract right now (learner-guided when learning is on). Risk style plays no part in this. */
    private _pick(raw_snapshots: TSnapshotMap): TCandidate | null {
        // The AI's self-review comes first: skip contracts its own history proves are losing, rank lagging ones lower.
        const gated = applyGate(raw_snapshots, this.hooks?.gate?.());
        // Rise/Fall waits until the 1-tick chart confirms a trend: leave out the ones that were just refused for that.
        const now = Date.now();
        const unblocked: TSnapshotMap = {};
        for (const [symbol, snap] of Object.entries(gated)) {
            unblocked[symbol] = {
                ...snap,
                signals: snap.signals.filter(sig => (this.blocked.get(`${symbol}|${sig.contract_type}`) ?? 0) <= now),
            };
        }
        // Quick 1-tick contracts first; longer contracts only when no 1-tick one is available.
        const snapshots = preferOneTick(unblocked);
        const learner = this.learner && this.learner.mode !== 'off' ? this.learner : undefined;
        return learner
            ? learner.pickBest(candidatesFromSnapshots<TDigitSignal>(snapshots, AUTOPILOT_CONTRACT_TYPES) as TCandidate[])
            : pickBestGlobalCandidate(snapshots);
    }

    /** The best tradable contract that is NOT the one that just lost (nor its opposite side). Null if there is none. */
    private _pickSwitch(lost: TCandidate): TCandidate | null {
        const skip = new Set([lost.contract_type, FLIP_PARTNER[lost.contract_type]].filter(Boolean));
        const snapshots = this.getSnapshots();
        const others: TSnapshotMap = {};
        for (const [symbol, snap] of Object.entries(snapshots)) {
            others[symbol] = { ...snap, signals: snap.signals.filter(sig => !skip.has(sig.contract_type)) };
        }
        return this._pick(others);
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

    /** Rise/Fall: bought only once the 1-tick chart shows a higher high (Rise) or a lower low (Fall). */
    private async _trendOk(candidate: TCandidate): Promise<boolean> {
        const need = TREND_NEEDED[candidate.contract_type];
        if (!need) return true;
        try {
            const res = await this.connection.send({ ticks_history: candidate.symbol, count: TREND_WINDOW, end: 'latest', style: 'ticks' });
            const prices: number[] = ((res?.history?.prices ?? []) as unknown[]).map(Number).filter(Number.isFinite);
            return detectTrend(prices) === need;
        } catch {
            return false; // no chart, no trend confirmation, no trade
        }
    }

    /** One auto-flip step: the partner after a loss, the original after the next one. Null when flipping is off / blocked. */
    private _autoFlipTarget(candidate: TCandidate): TCandidate | null {
        if (!this.config.auto_flip) return null;
        // The owner's switch rule wins over the self-review gate: the gate is meant to steer fresh picks, and applying it here
        // silently cancelled the switch whenever the journal held losses for the partner contract.
        const target = this.flip_origin ?? partnerCandidate(candidate.symbol, candidate);
        const came_back = !!this.flip_origin;
        this.flip_origin = came_back ? null : candidate;
        return target;
    }

    /** One paper trade on live ticks: resolves true (win), false (loss) or null (could not be settled). No money moves. */
    private _paperTrade(candidate: TCandidate): Promise<boolean | null> {
        const type = candidate.contract_type;
        const needed = isTouch(type) ? touch_ticks.get(`${candidate.symbol}|${type}`) ?? 5 : 1;
        return new Promise(resolve => {
            const quotes: number[] = [];
            let pip = 2;
            let done = false;
            let sub: number | null = null;
            const finish = (result: boolean | null) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (sub !== null) void this.connection.unsubscribe(sub);
                resolve(result);
            };
            const timer = setTimeout(() => finish(null), 45_000);
            sub = this.connection.subscribe({ ticks: candidate.symbol }, (data, err) => {
                if (done) return;
                if (err || !this.running) return finish(null);
                const tick = data?.tick;
                if (!tick) return;
                quotes.push(Number(tick.quote));
                if (Number.isFinite(Number(tick.pip_size))) pip = Number(tick.pip_size);
                // quotes[0] may be a tick from before the virtual buy; the entry is the next one, like a real purchase.
                if (quotes.length < 2) return;
                const result = paperOutcome(type, quotes[1], quotes.slice(2), pip, needed);
                if (result !== null) finish(result);
            });
        });
    }

    /** Real trading is paused after a loss; paper trades (switching like real ones) run until one wins, then real trading resumes. */
    private async _virtualHook(first: TCandidate, resume_stake: number) {
        this.busy = true; // nothing else may place a real trade meanwhile
        this.hooks?.onLog?.('info', `Virtual hook: real trading paused after a loss. Paper-trading until one wins, then back to real at stake ${resume_stake}.`);
        this._emit({ phase: 'virtual', virtual_state: 'start', virtual_losses: 0, symbol: first.symbol, label: first.label, contract_type: first.contract_type });
        let candidate = first;
        let losses = 0;
        let failures = 0;
        let trend_waits = 0;
        while (this.running) {
            this._emit({
                phase: 'virtual',
                virtual_state: 'paper',
                virtual_losses: losses,
                symbol: candidate.symbol,
                contract_type: candidate.contract_type,
                label: candidate.label,
            });
            if (!(await this._trendOk(candidate))) {
                if (!this.running) return;
                trend_waits += 1;
                if (trend_waits <= 20) {
                    await sleep(1500);
                    continue;
                }
                trend_waits = 0;
                const other = this._pick(this.getSnapshots());
                if (other) candidate = other;
                continue;
            }
            trend_waits = 0;
            const result = await this._paperTrade(candidate);
            if (!this.running) return;
            if (result === null) {
                failures += 1;
                if (failures >= 3) break; // ticks are not arriving: do not stay paused forever
                await sleep(1000);
                continue;
            }
            failures = 0;
            this._emit({
                phase: 'virtual',
                virtual_state: 'result',
                virtual_losses: result ? losses : losses + 1,
                symbol: candidate.symbol,
                contract_type: candidate.contract_type,
                label: candidate.label,
                result: result ? 'win' : 'loss',
            });
            if (result) {
                this.hooks?.onLog?.('success', `Virtual WIN on ${candidate.label} (${candidate.symbol}) after ${losses} virtual loss${losses === 1 ? '' : 'es'}: resuming real trading.`);
                break;
            }
            losses += 1;
            this.hooks?.onLog?.('info', `Virtual loss #${losses} on ${candidate.label} (${candidate.symbol}); still paper trading.`);
            candidate = this._autoFlipTarget(candidate) ?? this._pick(this.getSnapshots()) ?? candidate;
        }
        this.flip_origin = null;
        this.busy = false;
        if (this.running) {
            this._emit({ phase: 'virtual', virtual_state: 'end', virtual_losses: losses });
            this._findAndEnter(resume_stake);
        }
    }

    private _enter(candidate: TCandidate, wanted_stake: number, tag?: TAutoPilotEvent['tag'], waits = 0) {
        if (this.hook_pending) {
            this.hook_pending = false;
            if (PAPER_SUPPORTED.has(candidate.contract_type)) {
                void this._virtualHook(candidate, wanted_stake);
                return;
            }
            this.hooks?.onLog?.('info', `Virtual hook skipped: ${candidate.label} cannot be paper-traded.`);
        }
        if (!TREND_NEEDED[candidate.contract_type]) {
            this._enterNow(candidate, wanted_stake, tag);
            return;
        }
        this.busy = true;
        void this._trendOk(candidate).then(ok => {
            this.busy = false;
            if (!this.running) return;
            if (ok) {
                this._enterNow(candidate, wanted_stake, tag);
                return;
            }
            if (tag === 'flipped' && waits < 20) {
                if (waits === 0) this.hooks?.onLog?.('info', `Waiting for a ${TREND_NEEDED[candidate.contract_type] === 'bullish' ? 'higher-high' : 'lower-low'} trend on the 1-tick chart before ${candidate.label} on ${candidate.symbol}.`);
                setTimeout(() => this._enter(candidate, wanted_stake, tag, waits + 1), 1500);
                return;
            }
            this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 6000);
            this._findAndEnter(wanted_stake, tag);
        });
    }

    private _enterNow(candidate_in: TCandidate, wanted_stake_in: number, tag?: TAutoPilotEvent['tag']) {
        const candidate: TCandidate = candidate_in;
        // Capital protection: the first trades of a run never use more than the base stake.
        const protect = Math.max(0, Math.floor(this.config.protect_trades ?? 0));
        const wanted_stake = this.trade_count < protect ? Math.min(wanted_stake_in, this.config.stake) : wanted_stake_in;
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
                // Touch / No Touch: Deriv refused 5 ticks here, so use 10 ticks with the same 0.5 barrier before giving up.
                const touch_key = `${candidate.symbol}|${candidate.contract_type}`;
                if (isTouch(candidate.contract_type) && tried_duration === 5 && !touch_ticks.has(touch_key) && /duration|tick|barrier|offered/i.test(raw)) {
                    touch_ticks.set(touch_key, 10);
                    this.hooks?.onLog?.('info', `${candidate.label} refused at 5 ticks on ${candidate.symbol}; trying 10 ticks with the same 0.5 barrier.`);
                    if (this.step === 1) this.ladder_spent = 0; else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
                    setTimeout(() => this._enterNow(candidate, wanted_stake, tag), 300);
                    return;
                }
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

    private _watch(candidate: TCandidate, stake: number, contract_id: string, duration: number) {
        const entry_step = this.step;
        const entry_tag = this.entry_tag;
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
            this.trade_count += 1;

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
            // Capital protection: in the first trades of a run the loss allowed is only a few base stakes.
            const protect = Math.max(0, Math.floor(this.config.protect_trades ?? 0));
            if (protect > 0 && this.trade_count <= protect && this.total_profit <= -(this.config.stake * PROTECT_LOSS_STAKES)) {
                this.stop(`capital protection: lost ${PROTECT_LOSS_STAKES} base stakes in the first ${protect} trades`);
                return;
            }

            const mode = this.config.recovery_mode ?? 'reverse';
            const base_stake = this.config.stake;

            if (won) {
                this.consecutive_losses = 0;
                this.flip_origin = null; // a win ends any auto-flip sequence: next entry is a fresh pick
                this.hook_pending = false;
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
            this.hook_pending = !!this.config.virtual_hook; // the next entry is paper-traded until one wins
            this.win_streak = 0;
            this.streak_profit = 0;
            this.consecutive_losses += 1;
            const must_switch = this.consecutive_losses >= SWITCH_AFTER_LOSSES;
            if (must_switch) this.consecutive_losses = 0; // re-arm: the next switch is after 2 more losses

            // Switch to a different contract right now, instead of waiting for the market to turn.
            const switchTo = (next_stake: number): boolean => {
                // Auto flip (the owner's pairs): loss -> partner contract, next loss -> back to the original.
                const target = this._autoFlipTarget(candidate);
                if (target) {
                    this.hooks?.onLog?.('info', `Loss on ${candidate.label}: auto flip to ${target.label} on ${target.symbol}.`);
                    this._enter(target, next_stake, 'flipped');
                    return true;
                }
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
            const flip = pickFlipCandidate(this.getSnapshots(), candidate.symbol, candidate);
            if (isBlocked(this.hooks?.gate?.(), flip.symbol, flip.contract_type, (flip as { strategy?: string }).strategy)) {
                this.hooks?.onLog?.('info', `The opposite side (${flip.contract_type}) is skipped: its own results are clearly negative. Picking another contract.`);
                this._findAndEnter(next_stake);
                return;
            }
            this._enter(flip, next_stake, 'flipped');
        });
    }
}
