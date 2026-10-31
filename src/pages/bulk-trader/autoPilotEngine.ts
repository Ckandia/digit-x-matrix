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
    /** Capital protection: for the first N trades of a run the stake stays at the base stake (no growth) and a tight early loss limit applies. 0/undefined = off. */
    protect_trades?: number;
    /** Which contract families the AI may trade (keys of CONTRACT_FAMILIES). Undefined = no restriction (the older behaviour). */
    contract_families?: string[];
    /** Only Ups / Only Downs: BOTH sides are bought on every signal (same market, same stake each). Default on. */
    both_sides?: boolean;
    /**
     * Pacing: at most this many LIVE trades per hour (0 / undefined = no limit). A live buy that would come sooner than
     * 3600/N seconds after the previous one waits. Together with a small flat stake this is what bounds a 24-hour run's cost:
     * every contract here pays under 2x, so each trade loses a little on average and the loss grows with the NUMBER of trades.
     */
    max_trades_per_hour?: number;
    /**
     * Recovery stake (martingale mode). After a loss the next stake is sized to win back EVERYTHING the current ladder has lost
     * plus one base stake, at the payout the last contract showed. When the ladder runs out of steps or of budget it is dropped
     * (the loss is accepted), the stake goes back to the base stake and the run carries on; only the overall stop loss ends it.
     */
    recover_losses?: boolean;
};

/** The contract families the AI Trader tab lets you tick. Each is a pair of opposites; `trend` = needs a higher-high / lower-low on the 1-tick chart first. */
export const CONTRACT_FAMILIES: { key: string; label: string; types: [string, string]; trend?: boolean }[] = [
    { key: 'even_odd', label: 'Even / Odd', types: ['DIGITEVEN', 'DIGITODD'] },
    { key: 'over_under', label: 'Over 4 / Under 5', types: ['DIGITOVER', 'DIGITUNDER'] },
    { key: 'rise_fall', label: 'Rise / Fall', types: ['CALL', 'PUT'], trend: true },
    { key: 'touch', label: 'Touch / No Touch', types: ['ONETOUCH', 'NOTOUCH'] },
    { key: 'only_ups_downs', label: 'Only Ups / Only Downs', types: ['RUNHIGH', 'RUNLOW'], trend: true },
];
export const ALL_FAMILY_KEYS = CONTRACT_FAMILIES.map(f => f.key);

/** The early loss limit during capital protection, in base stakes. */
export const PROTECT_LOSS_STAKES = 3;
export const DEFAULT_PROTECT_TRADES = 10;
export const DEFAULT_MARTINGALE_MULTIPLIER = 1.2;

/** What a win paid in the owner's connector data (break-even win rates of 54.5-54.7% on the digit contracts => 1 / (1 + 0.83)). */
export const ASSUMED_PAYOUT_RATIO = 0.83;
/** Average LOSS of a fair 50/50 trade per unit of stake at that payout: 0.5 * 1 - 0.5 * 0.83 = 0.085 (it loses a little on average, every trade). */
export const EXPECTED_LOSS_PER_STAKE = 0.5 - 0.5 * ASSUMED_PAYOUT_RATIO;
/** Spread of one 50/50 trade per unit of stake: sqrt(0.5 * 0.5) * (1 + 0.83). */
export const SPREAD_PER_STAKE = 0.5 * (1 + ASSUMED_PAYOUT_RATIO);
export const MIN_STAKE = 0.35;
export const DEFAULT_TRADES_PER_HOUR = 15;
/** The share of the stop loss the plan lets itself use (expected cost + a 3-sigma bad run), so the stop loss is a net, not the plan. */
export const PLAN_STOP_LOSS_SHARE = 0.7;
/** Contracts ticked by default: the 1-tick digit contracts. Touch / No Touch and Only Ups / Downs lost the most per stake in the owner's data. */
export const SAFE_FAMILY_KEYS = ['even_odd', 'over_under'];

export type TDayPlan = {
    stake: number;
    trades_per_hour: number;
    trades: number;
    /** What the plan expects to lose to the payout over the whole run (a cost, not a risk). */
    expected_cost: number;
    /** Expected cost plus a 3-sigma bad run: the plan is built so this stays inside PLAN_STOP_LOSS_SHARE of the stop loss. */
    bad_run_loss: number;
    /** True when the minimum stake forced fewer trades than asked for. */
    trimmed: boolean;
};

/**
 * Sizes a run so its expected cost plus a 3-sigma bad run fits inside part of the stop loss. Every contract pays under 2x,
 * so a trade loses a little on average (about 8.5% of the stake at 0.83 payout) and the cost grows with stake x trades. This
 * does NOT make a run profitable and cannot guarantee the stop loss never triggers; it makes triggering very unlikely.
 */
export const planRun = (stop_loss: number, hours = 24, trades_per_hour = DEFAULT_TRADES_PER_HOUR): TDayPlan => {
    const budget = Math.max(0, Math.abs(stop_loss)) * PLAN_STOP_LOSS_SHARE;
    const bad = (stake: number, n: number) => stake * (n * EXPECTED_LOSS_PER_STAKE + 3 * SPREAD_PER_STAKE * Math.sqrt(n));
    let n = Math.max(1, Math.floor(hours * trades_per_hour));
    let stake = budget / (n * EXPECTED_LOSS_PER_STAKE + 3 * SPREAD_PER_STAKE * Math.sqrt(n));
    let trimmed = false;
    stake = Math.floor(stake * 100) / 100;
    if (stake < MIN_STAKE) {
        stake = MIN_STAKE;
        trimmed = true;
        while (n > 1 && bad(stake, n) > budget) n -= 1;
    }
    return {
        stake,
        trades: n,
        trades_per_hour: Math.max(1, Math.floor(n / hours)),
        expected_cost: Number((stake * n * EXPECTED_LOSS_PER_STAKE).toFixed(2)),
        bad_run_loss: Number(bad(stake, n).toFixed(2)),
        trimmed,
    };
};

/** The share of the stop loss a full failed recovery ladder may use, so the stop loss stays a net and not the plan. */
export const MARTINGALE_STOP_LOSS_SHARE = 0.6;

/**
 * The recovery stake: wins back everything lost so far in the ladder plus one base stake, at the payout the contract pays
 * (profit per unit stake). Example at 0.83: after a 1.00 loss the next stake is (1 + 1) / 0.83 = 2.41.
 */
export const recoveryStake = (ladder_spent: number, base: number, payout_ratio = ASSUMED_PAYOUT_RATIO): number => {
    const ratio = payout_ratio > 0.2 && payout_ratio < 2 ? payout_ratio : ASSUMED_PAYOUT_RATIO;
    return Math.max(MIN_STAKE, Math.ceil(((ladder_spent + base) / ratio) * 100) / 100);
};

/** The stakes of a whole recovery ladder (every step lost): base, then each recovery stake. */
export const recoveryLadder = (base: number, steps: number, payout_ratio = ASSUMED_PAYOUT_RATIO): number[] => {
    const out: number[] = [];
    let spent = 0;
    let stake = base;
    for (let i = 0; i < Math.max(1, steps); i++) {
        out.push(Number(stake.toFixed(2)));
        spent += stake;
        stake = recoveryStake(spent, base, payout_ratio);
    }
    return out;
};

export type TMartingalePlan = { stake: number; ladder: number[]; worst_ladder: number; trimmed: boolean };

/**
 * Sizes the BASE stake so that a full failed ladder (`steps` losses in a row) costs at most MARTINGALE_STOP_LOSS_SHARE of the
 * stop loss. A bigger stop loss gives a bigger base stake; a small account is held to the minimum stake (trimmed = true).
 * A recovery ladder wins back its losses when ANY step wins; it does not change the odds of a single trade.
 */
export const planMartingale = (stop_loss: number, steps: number, share = MARTINGALE_STOP_LOSS_SHARE): TMartingalePlan => {
    const budget = Math.max(0, Math.abs(stop_loss)) * share;
    const unit = recoveryLadder(1, steps).reduce((a, b) => a + b, 0);
    let stake = Math.floor((budget / unit) * 100) / 100;
    let trimmed = false;
    if (stake < MIN_STAKE) {
        stake = MIN_STAKE;
        trimmed = true;
    }
    const ladder = recoveryLadder(stake, steps);
    return { stake, ladder, worst_ladder: Number(ladder.reduce((a, b) => a + b, 0).toFixed(2)), trimmed };
};
/**
 * Both sides: a live trade fires the contract AND its opposite at once, but ONLY for Only Ups / Only Downs.
 * Every other contract (Even/Odd, Over 4/Under 5, Rise/Fall, Touch/No Touch) is bought on one side only.
 */
const bothSidesType = (type: string): boolean => type === 'RUNHIGH' || type === 'RUNLOW'; // ONLY Only Ups / Only Downs fire both sides
/** Two live legs that settle together as ONE trade (the stake ladder, stop loss and hook see the combined result). */
type TPair = { pending: number; profit: number; stake: number };

/** Turns a risk preset + live balance into the absolute numbers shown/edited
 *  in the UI. Editing a field in the UI just overwrites one of these — the
 *  preset is only ever a starting point, never enforced afterward. */
export const buildConfigFromPreset = (level: TRiskLevel, balance: number): TAutoPilotConfig => {
    const preset = RISK_PRESETS[level];
    const stop_loss = Number(((balance * preset.stop_loss_pct) / 100).toFixed(2));
    // 24-hour plan with RECOVERY: the base stake is sized so a full failed ladder fits inside part of the stop loss, a loss is
    // followed by a recovery stake that wins the ladder back, and every ticked contract is read from the latest ticks.
    const plan = planMartingale(stop_loss, preset.max_steps);
    return {
        recovery_mode: 'martingale',
        recover_losses: true,
        stake: plan.stake,
        max_trades_per_hour: 60,
        streak_multiplier: preset.streak_multiplier,
        max_streak: preset.max_streak,
        martingale_multiplier: preset.martingale_multiplier,
        max_steps: preset.max_steps,
        stop_loss,
        take_profit: Number(((balance * preset.take_profit_pct) / 100).toFixed(2)),
        protect_trades: 0, // protection capped the first 10 stakes at the base stake, which switched recovery off
        contract_families: ALL_FAMILY_KEYS,
        both_sides: true, // Only Ups / Only Downs only: buy both so one side's payout lands (see bothSidesType)
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

const OPPOSITE_LABEL: Record<string, string> = {
    DIGITEVEN: 'Even',
    DIGITODD: 'Odd',
    DIGITOVER: 'Over 4',
    DIGITUNDER: 'Under 5',
    CALL: 'Rise',
    PUT: 'Fall',
    ONETOUCH: 'Touch',
    NOTOUCH: 'No Touch',
    RUNHIGH: 'Only Ups',
    RUNLOW: 'Only Downs',
};


/** Contracts that wait for a confirmed trend on the 1-tick chart: Rise needs a higher high, Fall a lower low. */
/** How often the AI asks for a backend entry signal while it has none. */
export const SIGNAL_POLL_MS = 300;
export const DEFAULT_FOLLOW_TICKS = 2;
export const MAX_FOLLOW_TICKS = 5;
export const DEFAULT_ENTRY_TICK = 3;
export const MIN_ENTRY_TICK = 2;
export const MAX_ENTRY_TICK = 5;
export const DEFAULT_ENTRY_WAIT_TICKS = 30;
export const MIN_ENTRY_WAIT_TICKS = 10;
export const MAX_ENTRY_WAIT_TICKS = 90;
/** How long a contract with no entry stays skipped before the AI will consider it again. */
const NO_ENTRY_SKIP_MS = 120_000;

/**
 * Does this ONE tick agree with the contract? Digits test the tick's last digit; Rise/Fall test the move from the previous tick.
 * null = the contract has no stream rule.
 */
export const tickAgrees = (type: string, prediction: number | undefined, price: number, prev: number | undefined, pip: number): boolean | null => {
    const d = Number(price.toFixed(pip).slice(-1));
    switch (type) {
        case 'DIGITEVEN':
            return d % 2 === 0;
        case 'DIGITODD':
            return d % 2 === 1;
        case 'DIGITOVER':
            return d > (prediction ?? 4);
        case 'DIGITUNDER':
            return d < (prediction ?? 5);
        case 'CALL':
        case 'RUNHIGH':
            return prev !== undefined && price > prev;
        case 'PUT':
        case 'RUNLOW':
            return prev !== undefined && price < prev;
        default:
            return null;
    }
};

/** Length of the matching run at the end of `prices` (digits: matching last digits; Rise/Fall: moves in the contract's direction). */
export const trailingRun = (type: string, prediction: number | undefined, prices: number[], pip: number): number => {
    let run = 0;
    let prev: number | undefined;
    for (const q of prices) {
        const a = tickAgrees(type, prediction, q, prev, pip);
        run = a ? run + 1 : 0;
        prev = q;
    }
    return run;
};

/** Touch / No Touch read the market's speed: how far it usually travels in 5 ticks compared with the 0.5 barrier. */
export const TOUCH_BARRIER_ABS = 0.5;
export const TOUCH_READ_TICKS = 5;
/** Touch is entered when the market usually travels at least this multiple of the barrier in 5 ticks (and the last tick was up). */
export const TOUCH_READ_MIN = 1;
/** No Touch is entered when the market usually travels at most this multiple of the barrier in 5 ticks (a calm market). */
export const NOTOUCH_READ_MAX = 0.5;

/** Average tick-to-tick move over the last 20 ticks, scaled to `ticks` ticks, as a multiple of the barrier. null = too few ticks. */
export const reachRatio = (prices: number[], ticks = TOUCH_READ_TICKS, barrier = TOUCH_BARRIER_ABS): number | null => {
    const tail = prices.slice(-21);
    if (tail.length < 11) return null;
    let sum = 0;
    for (let i = 1; i < tail.length; i++) sum += Math.abs(tail[i] - tail[i - 1]);
    return ((sum / (tail.length - 1)) * Math.sqrt(ticks)) / barrier;
};

export const touchReading = (type: string, prices: number[]): boolean => {
    const r = reachRatio(prices);
    if (r === null) return false;
    if (type === 'ONETOUCH') return r >= TOUCH_READ_MIN && prices[prices.length - 1] > prices[prices.length - 2];
    return r <= NOTOUCH_READ_MAX;
};

/**
 * How close this contract's entry is to firing, 0..1, from the latest ticks only (no signal confidence). Stream contracts:
 * a run one tick short of `target` is 1 (the next matching tick is the entry); a run that is already `target` long or longer is
 * stale (0: it waits for a fresh run). Touch / No Touch: how well the market's speed fits the contract.
 */
export const entryScore = (type: string, prediction: number | undefined, prices: number[], pip: number, target = DEFAULT_ENTRY_TICK): number => {
    if (type === 'ONETOUCH' || type === 'NOTOUCH') {
        const r = reachRatio(prices);
        if (r === null) return 0;
        return type === 'ONETOUCH' ? Math.min(1, r / TOUCH_READ_MIN) : Math.min(1, NOTOUCH_READ_MAX / Math.max(r, 1e-6));
    }
    const run = trailingRun(type, prediction, prices, pip);
    if (run >= target) return 0;
    return run === target - 1 ? 1 : (run / Math.max(1, target - 1)) * 0.9;
};

/**
 * Do the latest `n` ticks already point this contract's way? null = this contract has no such rule.
 * Digits come from the last `n` prices (rounded to the market's decimals); Rise/Fall need `n` moves in a row.
 */
export const followsStream = (type: string, prediction: number | undefined, prices: number[], pip: number, n: number): boolean | null => {
    const digitOf = (price: number) => Number(price.toFixed(pip).slice(-1));
    const tail = prices.slice(-n).map(digitOf);
    const digitsOk = (test: (d: number) => boolean) => tail.length === n && tail.every(test);
    switch (type) {
        case 'DIGITEVEN':
            return digitsOk(d => d % 2 === 0);
        case 'DIGITODD':
            return digitsOk(d => d % 2 === 1);
        case 'DIGITOVER':
            return digitsOk(d => d > (prediction ?? 4));
        case 'DIGITUNDER':
            return digitsOk(d => d < (prediction ?? 5));
        case 'CALL':
        case 'PUT':
        case 'RUNHIGH':
        case 'RUNLOW': {
            const up = type === 'CALL' || type === 'RUNHIGH';
            const last = prices.slice(-(n + 1));
            if (last.length < n + 1) return false;
            for (let i = 1; i < last.length; i++) if (up ? !(last[i] > last[i - 1]) : !(last[i] < last[i - 1])) return false;
            return true;
        }
        case 'ONETOUCH':
        case 'NOTOUCH':
            return touchReading(type, prices);
        default:
            return null;
    }
};

const TREND_NEEDED: Record<string, 'bullish' | 'bearish'> = { CALL: 'bullish', PUT: 'bearish', RUNHIGH: 'bullish', RUNLOW: 'bearish' };

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
const REFUSAL_PATTERN = /not offered|duration|barrier|not available|unavailable|suspended|market is closed|no longer offered|selected tick|no return|offers no/i;

export type TCandidate = TDigitSignal & { symbol: string };

/** Best-confidence signal across every symbol, restricted to the families the
 *  auto-pilot is allowed to trade. Used for the very first entry, and again
 *  after every win (the ladder resets and re-scans from scratch). */
export const pickBestGlobalCandidate = (all_snapshots: TSnapshotMap, prefer_one_tick = true): TCandidate | null => {
    let best: TCandidate | null = null;
    const snapshots = prefer_one_tick ? preferOneTick(all_snapshots) : all_snapshots;
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
    private last_live_at = 0; // when the last live buy went out (pacing)
    private trade_count = 0; // settled trades in this run (capital protection counts these)
    private used_runs = new Set<string>(); // symbol|type|run id of the backend signals already traded: one run is traded once
    private poll_timer: ReturnType<typeof setTimeout> | null = null;
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
        this.last_live_at = 0;
        this.used_runs.clear();
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
        if (this.poll_timer) clearTimeout(this.poll_timer);
        this.poll_timer = null;
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

    /** The contract types the ticked families allow, or null when no restriction is set. */
    private _allowedTypes(): Set<string> | null {
        const keys = this.config.contract_families;
        if (!keys) return null;
        return new Set(CONTRACT_FAMILIES.filter(f => keys.includes(f.key)).flatMap(f => f.types));
    }

    /**
     * Signal execution. The backend reads the tick stream and marks a contract as an ENTRY signal the moment 3 or more ticks in
     * a row favour it (Even 2,4,6; Odd 1,3,7; Over 4 5,8,9; Under 5 2,1,4; Rise/Fall, Only Ups/Downs and Touch/No Touch the same
     * way) in a market whose bias favours it. The AI buys the strongest such signal as soon as it is received: no paper test, no
     * second wait on its own tick stream. The same run of ticks is never traded twice.
     */
    private _pickSignal(): TCandidate | null {
        const gated = applyGate(this.getSnapshots(), this.hooks?.gate?.());
        const allowed = this._allowedTypes();
        const now = Date.now();
        let best: TCandidate | null = null;
        for (const [symbol, snap] of Object.entries(gated)) {
            for (const sig of snap.signals) {
                if (sig.family !== 'run_bias' || !sig.entry) continue;
                if (allowed && !allowed.has(sig.contract_type)) continue;
                if ((this.blocked.get(`${symbol}|${sig.contract_type}`) ?? 0) > now) continue;
                if (sig.run_id !== undefined && this.used_runs.has(`${symbol}|${sig.contract_type}|${sig.run_id}`)) continue;
                const ticks = tradeTicks(symbol, sig.contract_type);
                if (ticks === null) continue;
                if (!best || sig.confidence > best.confidence) best = { ...sig, symbol, duration_ticks: ticks } as TCandidate;
            }
        }
        return best;
    }

    /** Looks for a backend entry signal; with none yet it asks again shortly (signals come and go with every tick). */
    private _findAndEnter(stake: number, tag?: TAutoPilotEvent['tag']) {
        if (!this.running || this.busy) return;
        if (this.poll_timer) clearTimeout(this.poll_timer);
        this.poll_timer = null;
        const candidate = this._pickSignal();
        if (!candidate) {
            if (Date.now() - this.last_wait_emit > 30_000) {
                this.last_wait_emit = Date.now();
                this._emit({ phase: 'waiting', reason: 'waiting for the backend to signal an entry (3 or more ticks in a row in favour of a contract)' });
            }
            this.poll_timer = setTimeout(() => this._findAndEnter(stake, tag), SIGNAL_POLL_MS);
            return;
        }
        this._enter(candidate, stake, tag);
    }

    /** Buys the signalled contract right away; Rise/Fall and Only Ups/Downs first need their trend on the 1-tick chart. */
    private _enter(candidate: TCandidate, wanted_stake: number, tag?: TAutoPilotEvent['tag']) {
        const run_id = (candidate as { run_id?: number | string }).run_id;
        if (run_id !== undefined) {
            if (this.used_runs.size > 500) this.used_runs.clear();
            this.used_runs.add(`${candidate.symbol}|${candidate.contract_type}|${run_id}`);
        }
        if (!TREND_NEEDED[candidate.contract_type]) {
            this._enterNow(candidate, wanted_stake, tag);
            return;
        }
        this.busy = true;
        void this._trendOk(candidate).then(trend_ok => {
            this.busy = false;
            if (!this.running) return;
            if (trend_ok) {
                this._enterNow(candidate, wanted_stake, tag);
                return;
            }
            this.hooks?.onLog?.('info', `Signal on ${candidate.symbol} for ${candidate.label} skipped: the 1-tick chart shows no confirmed trend.`);
            this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 5000);
            this._findAndEnter(wanted_stake, tag);
        });
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

    private _enterNow(candidate_in: TCandidate, wanted_stake_in: number, tag?: TAutoPilotEvent['tag']) {
        const candidate: TCandidate = candidate_in;
        // Pacing: never more than `max_trades_per_hour` live trades. A buy that would come too soon waits its turn.
        const per_hour = Math.floor(this.config.max_trades_per_hour ?? 0);
        if (per_hour > 0 && this.last_live_at > 0) {
            const wait_ms = this.last_live_at + 3_600_000 / per_hour - Date.now();
            if (wait_ms > 0) {
                this.busy = true; // nothing else may start a trade meanwhile
                setTimeout(() => {
                    this.busy = false; // _enterNow decides again (and sets it when it really buys)
                    if (!this.running) return;
                    this._enterNow(candidate, wanted_stake_in, tag);
                }, Math.min(wait_ms, 60_000) + 5);
                return;
            }
        }
        // Quality gate: in 'Only trade a proven edge' mode NO live buy happens for a contract without a proven edge.
        if (this.learner?.mode === 'edge_gate' && !this.learner.isTradable(candidate.symbol, candidate.contract_type, (candidate as { bucket?: string }).bucket, candidate.duration_ticks)) {
            if (Date.now() - this.last_wait_emit > 30_000) {
                this.last_wait_emit = Date.now();
                this.hooks?.onLog?.('info', `Standing aside: ${candidate.label} has no proven edge over its payout, so no real money is staked.`);
                this._emit({ phase: 'waiting', reason: 'no contract has a proven edge yet: standing aside' });
            }
            setTimeout(() => this._findAndEnter(wanted_stake_in, tag), 4000);
            return;
        }
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
        this.last_live_at = Date.now();
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
        // Both sides: the opposite contract is bought too, on the same market, same stake and same duration.
        let partner: TCandidate | null = null;
        let partner_parameters: Record<string, unknown> | null = null;
        if (this.config.both_sides !== false && bothSidesType(candidate.contract_type)) {
            const opposite_type = FLIP_PARTNER[candidate.contract_type];
            const live = this.connection.accountInfo?.balance;
            if (typeof live === 'number' && Number.isFinite(live) && stake * 2 > live) {
                this.hooks?.onLog?.('info', `Both sides skipped: two stakes of ${stake} ${this.currency} are more than the balance (${live.toFixed(2)}).`);
            } else if (opposite_type) {
                try {
                    const opposite: TCandidate = { ...candidate, prediction: opposite_type === 'DIGITOVER' ? 4 : opposite_type === 'DIGITUNDER' ? 5 : candidate.prediction, contract_type: opposite_type as TCandidate['contract_type'], label: OPPOSITE_LABEL[opposite_type] ?? opposite_type, basis: `Both sides: ${candidate.label} and ${OPPOSITE_LABEL[opposite_type] ?? opposite_type}.` };
                    partner_parameters = { ...buildTradeParameters(opposite, stake, this.currency), duration: tried_duration };
                    partner = opposite;
                } catch (err) {
                    this.hooks?.onLog?.('info', `Both sides skipped: ${err instanceof Error ? err.message : 'the opposite contract could not be built'}`);
                }
            }
        }
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
            .then(async res => {
                const contract_id = res?.buy?.contract_id;
                if (!contract_id) throw new Error('Buy did not return a contract id');
                if (!partner || !partner_parameters) {
                    this._watch(candidate, stake, contract_id, tried_duration);
                    return;
                }
                // The first side is bought: fire the other side right away. If it cannot be bought, the first side runs alone.
                let partner_id: string | null = null;
                try {
                    await this.connection.send({ proposal: 1, ...partner_parameters });
                    const bought = await this.connection.send({ buy: '1', price: stake, parameters: partner_parameters });
                    partner_id = bought?.buy?.contract_id ?? null;
                } catch (err) {
                    this.hooks?.onLog?.('error', `Second side ${partner.label} could not be bought: ${err instanceof Error ? err.message : 'refused'}. ${candidate.label} runs alone.`);
                }
                if (!partner_id) {
                    this._watch(candidate, stake, contract_id, tried_duration);
                    return;
                }
                this.ladder_spent = Number((this.ladder_spent + stake).toFixed(2));
                this.hooks?.onLog?.('info', `Both sides fired: ${candidate.label} + ${partner.label} on ${candidate.symbol}, stake ${stake} each.`);
                const pair: TPair = { pending: 2, profit: 0, stake: Number((stake * 2).toFixed(2)) };
                this._watch(candidate, stake, contract_id, tried_duration, pair);
                this._watch(partner, stake, partner_id, tried_duration, pair);
            })
            .catch(err => {
                this.busy = false;
                const raw = String(err?.message || 'Failed to place trade');
                if (/dropped/i.test(raw)) this.hooks?.onLog?.('error', 'The connection dropped while buying. Check Transactions: that contract may still be open.');
                const detail = `${candidate.contract_type} on ${candidate.symbol} for ${tried_duration} tick(s): ${raw}`;
                this.hooks?.onLog?.('error', detail);
                // Touch / No Touch: Deriv refused 5 ticks here, so use 10 ticks with the same 0.5 barrier before giving up.
                const touch_key = `${candidate.symbol}|${candidate.contract_type}`;
                if (isTouch(candidate.contract_type) && tried_duration === 5 && !touch_ticks.has(touch_key) && /duration|tick|barrier|offered|no return|offers no/i.test(raw)) {
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

    private _watch(candidate: TCandidate, stake: number, contract_id: string, duration: number, pair?: TPair) {
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

            // Both sides: the two legs are one trade. Nothing happens until the second one settles, then the COMBINED result drives the ladder.
            let net_profit = profit;
            let net_stake = stake;
            if (pair) {
                pair.profit = Number((pair.profit + profit).toFixed(2));
                pair.pending -= 1;
                if (pair.pending > 0) return; // still waiting for the other side (busy stays on)
                net_profit = pair.profit;
                net_stake = pair.stake;
                this.hooks?.onLog?.(net_profit > 0 ? 'success' : 'error', `Both sides closed: net ${net_profit >= 0 ? '+' : ''}${net_profit.toFixed(2)} ${this.currency} on ${candidate.symbol}.`);
            }
            const net_won = net_profit > 0;

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

            if (net_won) {
                this.consecutive_losses = 0;
                const next = (next_stake: number, tag?: TAutoPilotEvent['tag']) => this._findAndEnter(next_stake, tag);
                if (mode !== 'reverse') {
                    this.step = 1;
                    next(base_stake);
                    return;
                }
                // Reverse martingale: the stake grows only after a win, and only by what the streak has won.
                this.win_streak += 1;
                this.streak_profit = Number((this.streak_profit + net_profit).toFixed(2));
                const max_streak = Math.max(1, Math.floor(this.config.max_streak ?? 3));
                if (this.win_streak >= max_streak) {
                    this.hooks?.onLog?.('success', `${this.win_streak} wins in a row: gain banked, stake goes back to ${base_stake}.`);
                    this.win_streak = 0;
                    this.streak_profit = 0;
                    this.step = 1;
                    next(base_stake);
                    return;
                }
                const growth = Math.max(1, this.config.streak_multiplier ?? 1.8);
                // Never risk more than the base stake plus what this streak has already won.
                const next_stake = Number(Math.max(base_stake, Math.min(net_stake / (pair ? 2 : 1) * growth, base_stake + this.streak_profit)).toFixed(2));
                this.step = this.win_streak + 1;
                next(next_stake, 'streak');
                return;
            }

            // ---- a loss ----
            this.win_streak = 0;
            this.streak_profit = 0;
            this.consecutive_losses += 1;

            if (mode === 'reverse' || mode === 'flat') {
                // The stake does NOT go up after a loss: back to the base stake.
                this.step = 1;
                this._findAndEnter(base_stake);
                return;
            }

            // Recovery stake: win back the whole ladder plus one base stake, at the payout this contract showed.
            const recover = this.config.recover_losses === true && mode === 'martingale';
            const shown_ratio = Number(contract.payout) / Number(contract.buy_price) - 1;
            const dropLadder = (why: string) => {
                // The ladder is out of steps or budget: accept the loss, back to the base stake, keep trading (the stop loss still ends the run).
                this.hooks?.onLog?.('info', `Recovery ladder dropped (${why}): ${this.ladder_spent.toFixed(2)} ${this.currency} accepted as a loss, stake back to ${base_stake}.`);
                this.step = 1;
                this.ladder_spent = 0;
                this._findAndEnter(base_stake);
            };
            if (this.step >= this.config.max_steps) {
                if (recover) {
                    dropLadder(`${this.config.max_steps} steps lost`);
                    return;
                }
                this.stop('max recovery steps reached');
                return;
            }

            const next_stake = recover
                ? recoveryStake(this.ladder_spent, base_stake, shown_ratio)
                : Number((net_stake / (pair ? 2 : 1) * this.config.martingale_multiplier).toFixed(2));
            // Ladder budget: the whole recovery run may risk at most stop_loss in total.
            if (this.ladder_spent + next_stake > Math.abs(this.config.stop_loss)) {
                if (recover) {
                    dropLadder('the next stake would pass the stop-loss budget');
                    return;
                }
                this.stop('recovery ladder would exceed the stop-loss budget');
                return;
            }
            if (recover) this.hooks?.onLog?.('info', `Recovery stake ${next_stake} ${this.currency}: wins back ${this.ladder_spent.toFixed(2)} lost plus one base stake.`);
            this.step += 1;
            // The recovery trade is chosen by the AI: the best backend entry signal across every ticked contract and market.
            this._findAndEnter(next_stake);
        });
    }
}
