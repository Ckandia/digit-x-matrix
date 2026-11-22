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
    conservative: { stake_pct: 1, streak_multiplier: 1.5, max_streak: 3, martingale_multiplier: 1.5, max_steps: 4, stop_loss_pct: 10, take_profit_pct: 15 },
    moderate: { stake_pct: 2, streak_multiplier: 1.8, max_streak: 3, martingale_multiplier: 1.5, max_steps: 5, stop_loss_pct: 15, take_profit_pct: 20 },
    aggressive: { stake_pct: 3, streak_multiplier: 1.9, max_streak: 4, martingale_multiplier: 1.5, max_steps: 6, stop_loss_pct: 25, take_profit_pct: 30 },
};

/** How the stake behaves. 'martingale' (default) = the stake grows ONLY after a loss (x martingale_multiplier, default 1.5, up to max_steps
 *  losses) and goes back to the base stake after a win; a win never raises it. 'reverse' = reverse martingale: bigger stake after wins, base
 *  stake after a loss. 'flat' = same base stake always. A saved 'flip' (the old opposite-side ladder) runs as 'martingale'. */
export type TRecoveryMode = 'reverse' | 'martingale' | 'flip' | 'flat';
export const stakeMode = (m?: TRecoveryMode): 'reverse' | 'martingale' | 'flat' => (m === 'flat' ? 'flat' : m === 'martingale' || m === 'flip' ? 'martingale' : 'reverse');
export const DEFAULT_LOSS_MULTIPLIER = 1.5;
export const DEFAULT_MIN_CONFIDENCE = 20;
export const DEFAULT_SWITCH_AFTER_LOSSES = 2;
export const DEFAULT_SWITCH_WAIT_SECONDS = 45;

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
     * Slow-internet protection (ms; 0 = off). A signal is only valid for the very next tick, so on a slow line a buy lands after the
     * pattern has ended. The AI measures its round trip to Deriv and the lateness of the backend feed, and does not buy while the
     * connection is slower than this (default 500 ms). Signals that arrive late are dropped, never bought late.
     */
    max_latency_ms?: number;
    /**
     * Overlap pairs (default on). When Even and Under 5 BOTH have an entry on the same market at the same time (digits 0, 2, 4 are
     * even AND under 5), or Odd and Over 4 both do (digits 5, 7, 9 are odd AND over 4), both contracts are bought together. This is not
     * a hedge: they win together on 3 digits, one of them wins on 4 digits and none on 3, so the cost and the odds stay the same as two
     * separate bets. It only places the two bets on the same tick.
     */
    overlap_pairs?: boolean;
    /**
     * PAIRS ONLY (default on). The AI trades nothing but the ticked pairs, and the two legs of a pair are bought at the same moment, on
     * the same market, same stake each, counted as one trade: Only Ups + Only Downs, Even + Under 5, Odd + Over 4, Rise + Odd, Fall + Even.
     * A single contract is never bought in this mode. Off = the older behaviour (single contracts by family, pairs only as an extra).
     */
    pairs_only?: boolean;
    /** Which pairs may fire in pairs-only mode (keys of TRADE_PAIRS). Undefined = all five. */
    pair_keys?: string[];
    /**
     * Entry quality gate (0-100, same scale as a signal's confidence = (measured bias - 50) x 2). A signal below it is never bought, and the
     * highest-confidence signal across all markets goes first. 20 = the contract's measured hit rate on that market is at least 60%.
     * It picks the best moment the data shows, it cannot make a tick predictable. 0 / undefined = off.
     */
    min_confidence?: number;
    /**
     * 3-CONTRACT BASKET (default on). Every backend digit-pair signal buys THREE contracts in the same tick (Promise.all): the pair's two digit
     * contracts + Only Ups/Downs (momentum) or Rise/Fall (drift), see basketSetup. The stake is split 40/40/20 or 35/35/30 of the TOTAL stake
     * (`stake` = the total of the 3). Martingale: all 3 lose = total x martingale_multiplier (1.5); some win but the net is negative = the same
     * total; net >= 0 = back to the base total. Takes over from pairs_only and the single-contract families while on.
     */
    basket_mode?: boolean;
    /** Which bases the basket may fire on (keys of BASKET_BASES). Undefined = all four. */
    basket_keys?: string[];
    /** Basket only: add a 4th cover contract, Differs from the least frequent digit (wins about 9 times in 10 for a small payout). Off by default. */
    basket_cover?: boolean;
    /**
     * Recover on the SAME market and the SAME pair/contract after a loss (default on in the presets). Without it the AI prefers the market
     * traded least recently, so after a loss it moved to another market and another contract. It may switch only when one of the two
     * conditions below is met; a win always frees it to pick the best entry anywhere again.
     */
    stay_on_market?: boolean;
    /** Switch market after this many losses in a row on the same market (default 2): that market is not working. */
    switch_after_losses?: number;
    /** Switch market when the same market and pair gave no new entry for this many seconds after a loss (default 45). */
    switch_wait_seconds?: number;
};

/** The five pairs the AI fires at the same time in pairs-only mode. `signal` = which backend signal triggers it. */
export const TRADE_PAIRS: { key: string; label: string; types: [string, string] }[] = [
    { key: 'only_ups_downs', label: 'Only Ups + Only Downs', types: ['RUNHIGH', 'RUNLOW'] },
    { key: 'even_under5', label: 'Even + Under 5', types: ['DIGITEVEN', 'DIGITUNDER'] },
    { key: 'odd_over4', label: 'Odd + Over 4', types: ['DIGITODD', 'DIGITOVER'] },
    { key: 'rise_odd', label: 'Rise + Odd', types: ['CALL', 'DIGITODD'] },
    { key: 'fall_even', label: 'Fall + Even', types: ['PUT', 'DIGITEVEN'] },
];
export const ALL_PAIR_KEYS = TRADE_PAIRS.map(p => p.key);
/** The pair a backend signal belongs to: a pair signal carries `pair_key`; an Only Ups / Only Downs signal is the Only Ups + Only Downs pair. */
const pairKeyOf = (sig: { pair_key?: string; contract_type: string }): string | null =>
    sig.pair_key ?? (sig.contract_type === 'RUNHIGH' || sig.contract_type === 'RUNLOW' ? 'only_ups_downs' : null);
// ---------------------------------------------------------------------------------------------------------------------
// The 3-contract basket: one backend pair signal (a digit base) + a directional third contract, all three bought in the same tick.
//   Bases (blind spot = the digits where both digit legs lose):
//     A Even + Under 5 (5,7,9)   B Odd + Over 4 (0,2,4)   C Even + Over 4 (1,3)   D Odd + Under 5 (6,8)
//   Third contract: momentum (the last 3 ticks went the trend's way) = Only Ups / Only Downs (2 ticks), stakes 40/40/20;
//                   drift (otherwise) = Rise / Fall (1 tick), stakes 35/35/30. Bullish = Ups / Rise, bearish = Downs / Fall.
//   Setups 1-4 = A, 5-8 = B, 9-12 = C, 13-16 = D, each in the order: bullish momentum, bearish momentum, bullish drift, bearish drift.
// ---------------------------------------------------------------------------------------------------------------------
export const BASKET_BASES: { key: string; label: string; types: [string, string]; blind: string; first: number }[] = [
    { key: 'even_under5', label: 'Even + Under 5', types: ['DIGITEVEN', 'DIGITUNDER'], blind: '5, 7, 9', first: 1 },
    { key: 'odd_over4', label: 'Odd + Over 4', types: ['DIGITODD', 'DIGITOVER'], blind: '0, 2, 4', first: 5 },
    { key: 'even_over4', label: 'Even + Over 4', types: ['DIGITEVEN', 'DIGITOVER'], blind: '1, 3', first: 9 },
    { key: 'odd_under5', label: 'Odd + Under 5', types: ['DIGITODD', 'DIGITUNDER'], blind: '6, 8', first: 13 },
];
export const ALL_BASKET_KEYS = BASKET_BASES.map(b => b.key);
export const BASKET_MOMENTUM_SHARES = [0.4, 0.4, 0.2];
export const BASKET_DRIFT_SHARES = [0.35, 0.35, 0.3];
export const MIN_LEG_STAKE = 0.35; // Deriv's smallest stake per contract
export const BASKET_COVER_MOMENTUM_SHARES = [0.35, 0.35, 0.15, 0.15];
export const BASKET_COVER_DRIFT_SHARES = [0.3, 0.3, 0.25, 0.15];
export type TBasketLeg = { type: string; label: string; ticks: number; share: number; digit?: number };
export type TBasketSetup = { number: number; base: string; regime: 'momentum' | 'drift'; direction: 'bullish' | 'bearish'; legs: TBasketLeg[]; blind: string };
const BASKET_CONFLICTS: [string, string][] = [
    ['DIGITEVEN', 'DIGITODD'],
    ['DIGITOVER', 'DIGITUNDER'],
    ['CALL', 'PUT'],
    ['RUNHIGH', 'RUNLOW'],
    ['CALL', 'RUNLOW'],
    ['PUT', 'RUNHIGH'],
];
/** A basket never holds two contracts that cannot both win (Even + Odd, Rise + Fall ...). */
export const basketHasConflict = (types: string[]): boolean => BASKET_CONFLICTS.some(([a, b]) => types.includes(a) && types.includes(b));
export const basketSetup = (pair_key: string | undefined, direction: string | undefined, momentum: boolean, cover_digit?: number): TBasketSetup | null => {
    const base = BASKET_BASES.find(b => b.key === pair_key);
    if (!base || (direction !== 'bullish' && direction !== 'bearish')) return null;
    const bull = direction === 'bullish';
    const cover = Number.isInteger(cover_digit) && (cover_digit as number) >= 0 && (cover_digit as number) <= 9;
    const shares = cover ? (momentum ? BASKET_COVER_MOMENTUM_SHARES : BASKET_COVER_DRIFT_SHARES) : momentum ? BASKET_MOMENTUM_SHARES : BASKET_DRIFT_SHARES;
    const third: TBasketLeg = momentum
        ? { type: bull ? 'RUNHIGH' : 'RUNLOW', label: bull ? 'Only Ups' : 'Only Downs', ticks: 2, share: shares[2] }
        : { type: bull ? 'CALL' : 'PUT', label: bull ? 'Rise' : 'Fall', ticks: 1, share: shares[2] };
    const legs: TBasketLeg[] = [
        { type: base.types[0], label: OPPOSITE_LABEL[base.types[0]] ?? base.types[0], ticks: 1, share: shares[0] },
        { type: base.types[1], label: OPPOSITE_LABEL[base.types[1]] ?? base.types[1], ticks: 1, share: shares[1] },
        third,
    ];
    // The optional cover: Differs from the least frequent digit. It never conflicts with the other legs (it wins unless that one digit lands).
    if (cover) legs.push({ type: 'DIGITDIFF', label: `Differs ${cover_digit}`, ticks: 1, share: shares[3], digit: cover_digit });
    if (basketHasConflict(legs.map(l => l.type))) throw new Error(`Basket ${base.label} + ${third.label} holds contracts that cancel each other`);
    return { number: base.first + (momentum ? 0 : 2) + (bull ? 0 : 1), base: base.label, regime: momentum ? 'momentum' : 'drift', direction: bull ? 'bullish' : 'bearish', legs, blind: base.blind };
};
/** The smallest total stake that still gives every contract at least MIN_LEG_STAKE. */
export const basketMinTotal = (legs: TBasketLeg[]): number => Math.ceil((MIN_LEG_STAKE / Math.min(...legs.map(l => l.share))) * 100) / 100;
/** Splits a total stake by the legs' shares, to the cent; the last leg takes the rounding remainder so the legs add up to the total. */
export const basketStakes = (total: number, legs: TBasketLeg[]): number[] => {
    const parts = legs.slice(0, -1).map(l => Number((total * l.share).toFixed(2)));
    return [...parts, Number((total - parts.reduce((a, b) => a + b, 0)).toFixed(2))];
};

/**
 * Why a basket-mode AI is not buying, in one line, from what the backend is sending right now. Tells an old backend (no basket fields) apart from a
 * quiet market, and counts what removed the digit-pair entries it did see (no chart direction, third contract unsupported, replayed basket losing,
 * signal weaker than the minimum strength, base unticked).
 */
export const basketDiagnosis = (
    snapshots: Record<string, { signals: unknown[] }>,
    config: { basket_keys?: string[]; min_confidence?: number },
): string => {
    const keys = new Set(config.basket_keys ?? ALL_BASKET_KEYS);
    type S = { pair_key?: string; pair_types?: string[]; entry?: boolean; basket_entry?: boolean; basket_setup?: number | null; confidence?: number; basket?: { setup?: number | null; third_bias?: number | null } };
    let pair = 0, entries = 0, old_backend = 0, unticked = 0, no_direction = 0, third = 0, replay = 0, weak = 0, ready = 0;
    for (const snap of Object.values(snapshots)) {
        for (const raw of snap.signals as S[]) {
            if (!raw.pair_types || !raw.pair_key || !ALL_BASKET_KEYS.includes(raw.pair_key)) continue;
            pair += 1;
            if (raw.basket_setup === undefined) old_backend += 1;
            if (!raw.entry) continue;
            entries += 1;
            if (!keys.has(raw.pair_key)) unticked += 1;
            else if (raw.basket_entry !== true) {
                if (raw.basket_setup === null || raw.basket_setup === undefined) no_direction += 1;
                else if ((raw.basket?.third_bias ?? 100) < 55) third += 1;
                else replay += 1;
            } else if ((config.min_confidence ?? 0) > 0 && (raw.confidence ?? 0) < (config.min_confidence ?? 0)) weak += 1;
            else ready += 1;
        }
    }
    if (pair === 0) return 'The backend sent no digit-pair signals at all. Is the backend running and connected?';
    if (old_backend === pair) return 'The backend is an OLD version: it sends no basket fields (basket_entry / basket_setup), so no basket can be bought. Deploy the backend from this version (Render), then restart the AI.';
    if (entries === 0) return 'No digit-pair entry on any market right now (the last digits are not clustering). Waiting.';
    if (ready > 0) return `${ready} basket entr${ready === 1 ? 'y is' : 'ies are'} ready.`;
    const parts = [
        no_direction ? `${no_direction} had no chart direction` : '',
        third ? `${third} had no support for the third contract` : '',
        replay ? `${replay} were losing when replayed as a basket` : '',
        weak ? `${weak} were weaker than the minimum signal strength (${config.min_confidence})` : '',
        unticked ? `${unticked} were on an unticked base` : '',
    ].filter(Boolean);
    return `${entries} digit-pair entr${entries === 1 ? 'y' : 'ies'} seen, none is a basket entry: ${parts.join(', ')}.`;
};

/** What the recovery lock matches on: the pair a signal belongs to, or its contract type when it is a single contract. */
const recoveryKey = (c: { pair_key?: string; contract_type: string }): string => pairKeyOf(c) ?? c.contract_type;

/** The contract families the AI Trader tab lets you tick. Each is a pair of opposites; `trend` = needs a higher-high / lower-low on the 1-tick chart first. */
export const CONTRACT_FAMILIES: { key: string; label: string; types: [string, string]; trend?: boolean }[] = [
    { key: 'even_odd', label: 'Even / Odd', types: ['DIGITEVEN', 'DIGITODD'] },
    { key: 'over_under', label: 'Over 4 / Under 5', types: ['DIGITOVER', 'DIGITUNDER'] },
    { key: 'rise_fall', label: 'Rise / Fall', types: ['CALL', 'PUT'], trend: true },
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

/**
 * Both sides: a live trade fires the contract AND its opposite at once, but ONLY for Only Ups / Only Downs.
 * Every other contract (Even/Odd, Over 4/Under 5, Rise/Fall, Touch/No Touch) is bought on one side only.
 */
const bothSidesType = (type: string): boolean => type === 'RUNHIGH' || type === 'RUNLOW'; // ONLY Only Ups / Only Downs fire both sides
/** Two live legs that settle together as ONE trade (the stake ladder, stop loss and hook see the combined result). */
type TPair = { pending: number; profit: number; stake: number; basket?: boolean; returned?: number; legs?: number; intended?: number };

/** Turns a risk preset + live balance into the absolute numbers shown/edited
 *  in the UI. Editing a field in the UI just overwrites one of these — the
 *  preset is only ever a starting point, never enforced afterward. */
export const buildConfigFromPreset = (level: TRiskLevel, balance: number): TAutoPilotConfig => {
    const preset = RISK_PRESETS[level];
    const stop_loss = Number(((balance * preset.stop_loss_pct) / 100).toFixed(2));
    // 24-hour plan, no recovery ladder: a loss never raises the stake. The base stake is sized by planRun so a bad run stays inside
    // part of the stop loss; the reverse martingale (stake grows only after wins) is the default stake method.
    const plan = planRun(stop_loss);
    return {
        recovery_mode: 'martingale', // the stake grows only after a LOSS (x1.5); a win goes back to the base stake
        stake: plan.stake,
        max_trades_per_hour: 0, // no pacing: a signal is bought the next tick, not when a trades-per-hour timer allows
        streak_multiplier: preset.streak_multiplier,
        max_streak: preset.max_streak,
        martingale_multiplier: preset.martingale_multiplier,
        max_steps: preset.max_steps,
        stop_loss,
        take_profit: Number(((balance * preset.take_profit_pct) / 100).toFixed(2)),
        protect_trades: 0,
        contract_families: ALL_FAMILY_KEYS,
        both_sides: true,
        basket_mode: true, // every digit-pair signal buys the 3-contract basket at once; martingale x1.5 only after a full sweep
        basket_keys: ALL_BASKET_KEYS,
        stay_on_market: true, // recover a loss on the same market and pair; switch only after switch_after_losses losses or switch_wait_seconds without an entry
        switch_after_losses: DEFAULT_SWITCH_AFTER_LOSSES,
        switch_wait_seconds: DEFAULT_SWITCH_WAIT_SECONDS,
        min_confidence: DEFAULT_MIN_CONFIDENCE, // enter only on the strongest measured signals, best first
        pairs_only: true, // the AI trades only the five pairs, both legs at the same moment
        pair_keys: ALL_PAIR_KEYS,
        overlap_pairs: true, // Only Ups / Only Downs only: buy both so one side's payout lands (see bothSidesType)
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
    DIGITDIFF: 'Differs',
};


/** Contracts that wait for a confirmed trend on the 1-tick chart: Rise needs a higher high, Fall a lower low. */
/** How often the AI asks for a backend entry signal while it has none. */
export const SIGNAL_POLL_MS = 100;
export const DEFAULT_MAX_LATENCY_MS = 500;
/** A signal first seen longer ago than this is a run that has already ended: it is not bought. */
export const MAX_SIGNAL_AGE_MS = 1500;
/** A buy that takes this many times the allowed latency to be confirmed landed late (probably on a later tick than the signal). */
const LATE_BUY_FACTOR = 3;
/** This many late buys among the last 10 pause buying for LATE_PAUSE_MS. */
const LATE_BUYS_TO_PAUSE = 2;
const LATE_PAUSE_MS = 60_000;
const PING_EVERY_MS = 2000;
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
    /** How late the backend's frames arrive right now, in ms (0 on a good line). Used to refuse signals that reached the AI too late. */
    feedLagMs?: () => number;
};

/**
 * The three ticks of a trade, for the log: the pattern that triggered it, the entry tick and the exit tick Deriv actually used.
 * The exit tick decides win or lose. Digit contracts show the last digit (a trailing 0 is kept: Deriv prints 100.50).
 */
export const describeTicks = (candidate: TCandidate, contract: Record<string, unknown>): { signal: string; entry: string; exit: string; text: string } => {
    const pattern = (candidate as { run?: { pattern?: string[] } }).run?.pattern ?? [];
    const digits = candidate.contract_type.startsWith('DIGIT');
    const shown = (v: unknown): string => {
        const raw = String(v ?? '').trim();
        if (!raw) return '?';
        return digits ? raw.slice(-1) : raw;
    };
    const entry = shown(contract.entry_tick_display_value ?? contract.entry_tick ?? contract.entry_spot_display_value ?? contract.entry_spot);
    const exit = shown(contract.exit_tick_display_value ?? contract.exit_tick ?? contract.exit_spot_display_value ?? contract.exit_spot);
    const signal = pattern.join(', ');
    const what = digits ? 'digit' : 'price';
    return { signal, entry, exit, text: `${signal ? `signal ${signal} -> ` : ''}entry tick ${entry} -> exit tick ${exit} (${what} that decides the trade)` };
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
    tag?: 'flipped' | 'switched' | 'streak' | 'recovery';
    /** The ticks of this trade as printed: the pattern that triggered it, then Deriv's entry and exit tick. */
    signal_ticks?: string;
    entry_tick?: string;
    exit_tick?: string;
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
    tag?: 'flipped' | 'switched' | 'streak' | 'recovery';
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
    private rtts: number[] = []; // the last pings to Deriv, ms (Infinity = no answer)
    private ping_timer: ReturnType<typeof setInterval> | null = null;
    private seen_at = new Map<string, number>(); // signal key -> when the AI first saw it
    private buy_log: boolean[] = []; // the last 10 buys: true = it landed late
    private paused_until = 0;
    private started_at = 0;
    private last_slow_log = 0;
    private last_market: string | null = null;
    private lock: { symbol: string; key: string; since: number; losses: number } | null = null; // recovery: stay on this market and pair until released
    private last_traded = new Map<string, number>(); // symbol -> when the AI last bought on it (market switching)
    private used_runs = new Set<string>(); // symbol|type|run id of the backend signals already traded: one run is traded once
    private poll_timer: ReturnType<typeof setTimeout> | null = null;
    private waiting: { stake: number; tag?: TAutoPilotEvent['tag'] } | null = null; // set while the AI waits for a signal
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
        this.seen_at.clear();
        this.rtts = [];
        this.buy_log = [];
        this.paused_until = 0;
        this.started_at = Date.now();
        this._startPing();
        this.used_runs.clear();
        this.last_traded.clear();
        this.last_market = null;
        this.lock = null;
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
        if (this.ping_timer) clearInterval(this.ping_timer);
        this.ping_timer = null;
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
        // The self-review gate blocks single contracts by their past results ("All markets DIGITEVEN"). A basket signal carries its first digit contract
        // as contract_type, so the gate used to block every Even / Odd basket for good while the log said "basket entry is ready". The basket is not judged
        // by that single-contract history: in basket mode the raw signals are used.
        const gated = this.config.basket_mode === true ? this.getSnapshots() : applyGate(this.getSnapshots(), this.hooks?.gate?.());
        const allowed = this._allowedTypes();
        const now = Date.now();
        const found: { candidate: TCandidate; confluence: boolean; idle: number; pair: boolean }[] = [];
        const pairs_only = this.config.pairs_only === true;
        const pair_keys = new Set(this.config.pair_keys ?? ALL_PAIR_KEYS);
        const basket = this.config.basket_mode === true;
        const basket_keys = new Set(this.config.basket_keys ?? ALL_BASKET_KEYS);
        // Recovery lock: after a loss only the same market and the same pair/contract may be bought, until a switch condition is met.
        if (this.lock) {
            const wait_ms = Math.max(0, this.config.switch_wait_seconds ?? DEFAULT_SWITCH_WAIT_SECONDS) * 1000;
            if (wait_ms > 0 && now - this.lock.since > wait_ms) {
                this.hooks?.onLog?.('info', `No new entry on ${this.lock.symbol} for ${Math.round(wait_ms / 1000)}s: switching market.`);
                this.lock = null;
            }
        }
        const lock = this.lock;
        for (const [symbol, snap] of Object.entries(gated)) {
            if (lock && symbol !== lock.symbol) continue;
            for (const sig of snap.signals) {
                if (sig.family !== 'run_bias' || !sig.entry) continue;
                if (sig.contract_type === 'ONETOUCH' || sig.contract_type === 'NOTOUCH') continue; // Touch / No Touch are not traded by the AI
                if ((this.config.min_confidence ?? 0) > 0 && (sig.confidence ?? 0) < (this.config.min_confidence ?? 0)) continue; // not strong enough
                if (lock && recoveryKey(sig as { pair_key?: string; contract_type: string }) !== lock.key) continue; // recover with the same pair/contract
                // A PAIR signal: the sequence favours two contracts at once (0,2,4 = Even + Under 5; 5,7,9 = Odd + Over 4; rising + odd = Rise + Odd; falling + even = Fall + Even).
                const pair_types = (sig as { pair_types?: string[] }).pair_types;
                if (basket) {
                    // 3-contract basket: only a digit-pair signal of a ticked base, with a chart direction (bullish / bearish) for the third contract.
                    // The backend judges the entry on the whole basket (digit pair + third contract + replayed basket result): `basket_entry`.
                    const bk = (sig as { pair_key?: string }).pair_key;
                    // The third contract leans the way the backend says (the trend, else the last tick's move): no confirmed trend is needed.
                    const dir = (sig as { basket_direction?: string }).basket_direction ?? (sig as { trend?: string }).trend;
                    if (!pair_types || !bk || !basket_keys.has(bk) || (dir !== 'bullish' && dir !== 'bearish')) continue;
                    if ((sig as { basket_entry?: boolean }).basket_entry !== true) continue;
                } else if (pairs_only) {
                    // Pairs only: nothing but a ticked pair is traded, never a single contract.
                    const pk = pairKeyOf(sig as { pair_key?: string; contract_type: string });
                    if (!pk || !pair_keys.has(pk)) continue;
                    if (pair_types && pair_types.length !== 2) continue;
                } else {
                    if (pair_types && (this.config.overlap_pairs === false || pair_types.length !== 2)) continue;
                    if (allowed && !allowed.has(sig.contract_type)) continue;
                    if (pair_types && allowed && !allowed.has(pair_types[1])) continue;
                }
                if (pair_types && (this.blocked.get(`${symbol}|${pair_types[1]}`) ?? 0) > now) continue;
                if (pair_types && tradeTicks(symbol, pair_types[1]) === null) continue;
                if ((this.blocked.get(`${symbol}|${sig.contract_type}`) ?? 0) > now) continue;
                if (sig.run_id !== undefined && this.used_runs.has(`${symbol}|${sig.contract_type}|${sig.run_id}`)) continue;
                const ticks = tradeTicks(symbol, sig.contract_type);
                if (ticks === null) continue;
                // A signal is for the very next tick: one the AI has been looking at for too long is a run that has already ended.
                const key = `${symbol}|${sig.contract_type}|${sig.run_id}`;
                const first = this.seen_at.get(key) ?? now;
                if (!this.seen_at.has(key)) {
                    if (this.seen_at.size > 500) this.seen_at.clear();
                    this.seen_at.set(key, now);
                }
                if (now - first > MAX_SIGNAL_AGE_MS) continue;
                const second = pair_types ? pair_types[1] : null;
                const candidate = (
                    second
                        ? {
                              ...sig,
                              symbol,
                              duration_ticks: ticks,
                              label: OPPOSITE_LABEL[sig.contract_type] ?? sig.label,
                              pair_with: {
                                  ...sig,
                                  symbol,
                                  duration_ticks: ticks,
                                  contract_type: second,
                                  prediction: second === 'DIGITUNDER' ? 5 : second === 'DIGITOVER' ? 4 : undefined,
                                  label: OPPOSITE_LABEL[second] ?? second,
                              },
                          }
                        : { ...sig, symbol, duration_ticks: ticks }
                ) as TCandidate;
                found.push({
                    candidate,
                    pair: !!second,
                    confluence: sig.confluence === true,
                    idle: now - (this.last_traded.get(symbol) ?? 0), // how long this market has not been traded: a market never traded is the idlest
                });
            }
        }
        if (!found.length) return null;
        // Market switching: when several markets have an entry at the same time, the one that agrees on every run length (confluence)
        // goes first, then a PAIR (the digit sequence favours two contracts at once), then the market traded LEAST recently, and only then
        // the strongest bias. The strongest bias alone kept picking the same market, because a market's bias changes slowly.
        const best_first = (this.config.min_confidence ?? 0) > 0; // quality gate on: the strongest measured signal goes first
        found.sort((a, b) => (best_first ? b.candidate.confidence - a.candidate.confidence : 0) || Number(b.confluence) - Number(a.confluence) || Number(b.pair) - Number(a.pair) || b.idle - a.idle || b.candidate.confidence - a.candidate.confidence);
        return found[0].candidate;
    }

    private _startPing() {
        if (this.ping_timer) clearInterval(this.ping_timer);
        const ping = () => {
            const t0 = Date.now();
            this.connection
                .send({ ping: 1 })
                .then(() => this.rtts.push(Date.now() - t0))
                .catch(() => this.rtts.push(Infinity))
                .finally(() => {
                    if (this.rtts.length > 5) this.rtts.shift();
                    this.signalReceived(); // a waiting AI looks again now that the connection has been measured
                });
        };
        ping();
        this.ping_timer = setInterval(ping, PING_EVERY_MS);
    }

    /** The middle of the last pings to Deriv, in ms (0 = nothing measured yet, Infinity = Deriv is not answering). */
    latencyMs(): number {
        if (!this.rtts.length) return 0;
        const sorted = [...this.rtts].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    /** Why the AI must not buy right now because of the connection (null = the connection is fine). */
    private _connectionProblem(): string | null {
        const limit = this.config.max_latency_ms ?? DEFAULT_MAX_LATENCY_MS;
        if (limit <= 0) return null;
        const now = Date.now();
        if (now < this.paused_until) return `trades have been landing late, paused for ${Math.ceil((this.paused_until - now) / 1000)}s`;
        if (!this.rtts.length && now - this.started_at < 3000) return 'measuring the connection'; // never buy blind: wait for the first ping
        const rtt = this.latencyMs();
        if (rtt > limit) return Number.isFinite(rtt) ? `your connection to Deriv is slow (${Math.round(rtt)} ms, limit ${limit} ms)` : 'Deriv is not answering';
        const last = this.rtts[this.rtts.length - 1];
        if (last !== undefined && last > limit * 2) return `your connection just stalled (${Number.isFinite(last) ? Math.round(last) + ' ms' : 'no answer'})`;
        const lag = this.hooks?.feedLagMs?.() ?? 0;
        if (lag > limit) return `the signal feed is arriving ${Math.round(lag)} ms late`;
        return null;
    }

    /** Called after every buy with how long Deriv took to confirm it: two late buys in the last ten pause buying for a minute. */
    private _noteBuy(ms: number) {
        const limit = this.config.max_latency_ms ?? DEFAULT_MAX_LATENCY_MS;
        if (limit <= 0) return;
        this.buy_log.push(ms > limit * LATE_BUY_FACTOR);
        if (this.buy_log.length > 10) this.buy_log.shift();
        if (this.buy_log.filter(Boolean).length >= LATE_BUYS_TO_PAUSE) {
            this.paused_until = Date.now() + LATE_PAUSE_MS;
            this.buy_log = [];
            this.hooks?.onLog?.('error', `Buys are being confirmed late (${Math.round(ms)} ms): signals last one tick, so these trades land on the wrong tick. Pausing for ${LATE_PAUSE_MS / 1000}s.`);
        }
    }

    /** The panel calls this the moment a new snapshot arrives from the backend: a waiting AI looks at it at once instead of at its next poll. */
    signalReceived() {
        if (!this.running || this.busy || !this.waiting) return;
        this._findAndEnter(this.waiting.stake, this.waiting.tag);
    }

    /** After a loss: keep the AI on this market and pair, or release it once this market has lost switch_after_losses times in a row. */
    private _holdMarket(candidate: TCandidate) {
        if (this.config.stay_on_market !== true) return;
        const losses = this.lock && this.lock.symbol === candidate.symbol ? this.lock.losses + 1 : 1;
        const limit = Math.max(1, Math.floor(this.config.switch_after_losses ?? DEFAULT_SWITCH_AFTER_LOSSES));
        if (losses >= limit) {
            this.lock = null;
            this.hooks?.onLog?.('info', `${losses} loss${losses > 1 ? 'es' : ''} in a row on ${candidate.symbol}: ${candidate.symbol} is not working, the AI may switch market now.`);
            return;
        }
        this.lock = { symbol: candidate.symbol, key: recoveryKey(candidate as unknown as { pair_key?: string; contract_type: string }), since: Date.now(), losses };
        this.hooks?.onLog?.('info', `Loss on ${candidate.symbol}: recovering on the same market and pair (switch after ${limit} losses in a row or ${this.config.switch_wait_seconds ?? DEFAULT_SWITCH_WAIT_SECONDS}s without an entry).`);
    }

    /** Looks for a backend entry signal; with none yet it asks again shortly (signals come and go with every tick). */
    private _findAndEnter(stake: number, tag?: TAutoPilotEvent['tag']) {
        if (!this.running || this.busy) return;
        if (this.poll_timer) clearTimeout(this.poll_timer);
        this.poll_timer = null;
        const candidate = this._pickSignal();
        const problem = candidate ? this._connectionProblem() : null;
        if (candidate && problem) {
            // A signal is only good for the very next tick. With this connection it would land late, so it is dropped (never bought late).
            const run_id = (candidate as { run_id?: number | string }).run_id;
            const measuring = problem === 'measuring the connection'; // only the first moments of a run: wait, do not throw the signal away
            if (run_id !== undefined && !measuring) this.used_runs.add(`${candidate.symbol}|${candidate.contract_type}|${run_id}`);
            if (!measuring && Date.now() - this.last_slow_log > 15_000) {
                this.last_slow_log = Date.now();
                this.hooks?.onLog?.('info', `Signal on ${candidate.symbol} not bought: ${problem}. Waiting for the connection to recover.`);
                this._emit({ phase: 'waiting', reason: `not buying: ${problem}` });
            }
            this.waiting = { stake, tag };
            this.poll_timer = setTimeout(() => this._findAndEnter(stake, tag), problem === 'measuring the connection' ? 50 : 300);
            return;
        }
        this.waiting = candidate ? null : { stake, tag };
        if (!candidate) {
            if (Date.now() - this.last_wait_emit > 30_000) {
                this.last_wait_emit = Date.now();
                if (this.config.basket_mode === true && Date.now() - this.started_at < 10_000) {
                    this.last_wait_emit = Date.now() - 20_000; // the first snapshots may still be arriving: look again in 10 seconds
                } else if (this.config.basket_mode === true) {
                    // Say WHY nothing is being bought, so a silent AI is never a mystery (an old backend, no direction, a locked market ...).
                    const why = basketDiagnosis(this.getSnapshots() as Record<string, { signals: unknown[] }>, this.config);
                    const lock = this.lock ? ` Recovering on ${this.lock.symbol}: only that market and pair may be bought (switch after ${this.config.switch_wait_seconds ?? DEFAULT_SWITCH_WAIT_SECONDS}s without an entry).` : '';
                    this.hooks?.onLog?.(/OLD version|no digit-pair signals at all/.test(why) ? 'error' : 'info', `Not buying yet: ${why}${lock}`);
                    this._emit({ phase: 'waiting', reason: `${why}${lock}` });
                } else this._emit({ phase: 'waiting', reason: 'waiting for the backend to signal an entry (3 or more ticks in a row in favour of a contract)' });
            }
            this.poll_timer = setTimeout(() => this._findAndEnter(stake, tag), SIGNAL_POLL_MS);
            return;
        }
        this._enter(candidate, stake, tag);
    }

    /** Is the signal still on the backend's feed right now (same contract, market and run)? A run that already ended is not bought. */
    private _stillValid(candidate: TCandidate): boolean {
        const run_id = (candidate as { run_id?: number | string }).run_id;
        const snap = this.getSnapshots()[candidate.symbol];
        if (!snap) return true;
        return snap.signals.some(sg => sg.family === 'run_bias' && sg.entry && sg.contract_type === candidate.contract_type && (run_id === undefined || sg.run_id === run_id));
    }

    /**
     * Buys the signalled contract on the very next tick: no price check first, no chart request. The backend has already confirmed the
     * trend on the 1-tick chart for Rise/Fall and Only Ups/Downs (the signal carries it); only a signal without that confirmation
     * falls back to asking for the chart.
     */
    private _enter(candidate: TCandidate, wanted_stake: number, tag?: TAutoPilotEvent['tag']) {
        const run_id = (candidate as { run_id?: number | string }).run_id;
        if (run_id !== undefined) {
            if (this.used_runs.size > 500) this.used_runs.clear();
            this.used_runs.add(`${candidate.symbol}|${candidate.contract_type}|${run_id}`);
        }
        const mate = (candidate as { pair_with?: TCandidate & { run_id?: number | string } }).pair_with;
        if (mate) {
            // The pair uses up the run, and also the single Even / Under 5 (or Odd / Over 4) entries of the same moment: no double buying.
            if (run_id !== undefined) this.used_runs.add(`${mate.symbol}|${mate.contract_type}|${run_id}`);
            for (const sg of this.getSnapshots()[candidate.symbol]?.signals ?? []) {
                if (sg.family === 'run_bias' && sg.entry && sg.run_id !== undefined && (sg.contract_type === candidate.contract_type || sg.contract_type === mate.contract_type)) {
                    this.used_runs.add(`${candidate.symbol}|${sg.contract_type}|${sg.run_id}`);
                }
            }
        }
        if (this.last_market && this.last_market !== candidate.symbol) {
            this.hooks?.onLog?.('info', `Switching market: ${this.last_market} -> ${candidate.symbol} (${candidate.label}, the entry came on ${candidate.symbol}).`);
        }
        this.last_market = candidate.symbol;
        this.last_traded.set(candidate.symbol, Date.now());
        const need = TREND_NEEDED[candidate.contract_type];
        if (!need || (candidate as { trend?: string }).trend === need) {
            this._enterNow(candidate, wanted_stake, tag);
            return;
        }
        this.busy = true;
        void this._trendOk(candidate).then(trend_ok => {
            this.busy = false;
            if (!this.running) return;
            if (trend_ok && this._stillValid(candidate)) {
                this._enterNow(candidate, wanted_stake, tag);
                return;
            }
            this.hooks?.onLog?.('info', `Signal on ${candidate.symbol} for ${candidate.label} skipped: ${trend_ok ? 'the run already ended' : 'the 1-tick chart shows no confirmed trend'}.`);
            this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 5000);
            this._findAndEnter(wanted_stake, tag);
        });
    }

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
        if (this.config.basket_mode === true && BASKET_BASES.some(b => b.key === (candidate as { pair_key?: string }).pair_key)) {
            this._enterBasket(candidate, wanted_stake_in, tag);
            return;
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
        const pairs_only = this.config.pairs_only === true;
        // Both sides: the opposite contract is bought too, on the same market, same stake and same duration.
        let partner: TCandidate | null = null;
        let partner_parameters: Record<string, unknown> | null = null;
        const overlap = (candidate as { pair_with?: TCandidate }).pair_with ?? null;
        if (overlap) {
            const live = this.connection.accountInfo?.balance;
            if (typeof live === 'number' && Number.isFinite(live) && stake * 2 > live) {
                this.hooks?.onLog?.('info', `Pair skipped: two stakes of ${stake} ${this.currency} are more than the balance (${live.toFixed(2)}); buying ${candidate.label} alone.`);
            } else {
                try {
                    partner_parameters = { ...buildTradeParameters(overlap, stake, this.currency), duration: tried_duration };
                    partner = overlap;
                } catch (err) {
                    this.hooks?.onLog?.('info', `Pair skipped: ${err instanceof Error ? err.message : 'the second contract could not be built'}`);
                }
            }
        } else if ((pairs_only || this.config.both_sides !== false) && bothSidesType(candidate.contract_type)) {
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
        if (pairs_only && !partner) {
            // Pairs only: one leg alone is not the logic being tested. Nothing was sent to Deriv, so drop this signal.
            this.busy = false;
            if (this.step === 1) this.ladder_spent = 0; else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
            const live = this.connection.accountInfo?.balance;
            if (typeof live === 'number' && Number.isFinite(live) && stake * 2 > live) {
                this.hooks?.onLog?.('error', `A pair needs two stakes of ${stake} ${this.currency}, the balance is ${live.toFixed(2)}. Stopping.`);
                this.stop('balance is too low for a pair of stakes');
                return;
            }
            this.hooks?.onLog?.('info', `Pair on ${candidate.symbol} not bought: the second leg could not be built. Waiting for the next signal.`);
            this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 5000);
            setTimeout(() => this._findAndEnter(wanted_stake, tag), 500);
            return;
        }
        this.hooks?.onLog?.(
            'info',
            `Buying ${candidate.contract_type} on ${candidate.symbol}, ${tried_duration} tick(s), stake ${stake} ${this.currency}` +
                (candidate.prediction !== undefined ? `, prediction ${candidate.prediction}` : '')
        );
        // Straight to the buy: a single contract is bought at once (price = the stake is the most Deriv may charge, and a refusal comes back
        // from the buy itself). Both sides: both legs are priced together first (a winning side must pay at least BOTH stakes), then both
        // legs are bought together, so the second leg lands on the same tick as the first.
        const buyLeg = async (params: Record<string, unknown>): Promise<string> => {
            const t0 = Date.now();
            const res = await this.connection.send({ buy: '1', price: stake, parameters: params });
            this._noteBuy(Date.now() - t0);
            const id = res?.buy?.contract_id;
            if (!id) throw new Error('Buy did not return a contract id');
            return id as string; // keep it exactly as Deriv sent it (a number): proposal_open_contract rejects a string contract_id
        };
        const priced: Promise<void> =
            partner && partner_parameters && !overlap && !pairs_only // in pairs-only mode both legs always go at once (no payout cover check); an overlap pair is not about a payout covering both stakes: no price check, both legs go at once
                ? Promise.all([this.connection.send({ proposal: 1, ...parameters }), this.connection.send({ proposal: 1, ...partner_parameters })]).then(([a, b]) => {
                      const need = Number((stake * 2).toFixed(2));
                      const pay_a = Number(a?.proposal?.payout);
                      const pay_b = Number(b?.proposal?.payout);
                      if (!(pay_a >= need) || !(pay_b >= need)) {
                          const low = Math.min(Number.isFinite(pay_a) ? pay_a : 0, Number.isFinite(pay_b) ? pay_b : 0);
                          throw Object.assign(new Error(`both sides cost ${need.toFixed(2)} but a winning side would pay only ${low.toFixed(2)}`), { cover: true });
                      }
                  })
                : Promise.resolve();
        priced
            .then(async () => {
                if (!partner || !partner_parameters) {
                    this._watch(candidate, stake, await buyLeg(parameters), tried_duration);
                    return;
                }
                const [first, second] = await Promise.allSettled([buyLeg(parameters), buyLeg(partner_parameters)]);
                if (first.status === 'rejected' && second.status === 'rejected') throw first.reason;
                if (first.status === 'rejected' || second.status === 'rejected') {
                    // Only one side got through: it runs alone.
                    const alive = first.status === 'fulfilled' ? { c: candidate, id: first.value, lost: partner.label } : { c: partner, id: (second as PromiseFulfilledResult<string>).value, lost: candidate.label };
                    this.hooks?.onLog?.('error', `Second side ${alive.lost} could not be bought. ${alive.c.label} runs alone.`);
                    this._watch(alive.c, stake, alive.id, tried_duration);
                    return;
                }
                this.ladder_spent = Number((this.ladder_spent + stake).toFixed(2));
                this.hooks?.onLog?.('info', `${overlap ? 'Overlap pair' : 'Both sides'} fired together: ${candidate.label} + ${partner.label} on ${candidate.symbol}, stake ${stake} each.`);
                const pair: TPair = { pending: 2, profit: 0, stake: Number((stake * 2).toFixed(2)) };
                this._watch(candidate, stake, first.value, tried_duration, pair);
                this._watch(partner, stake, second.value, tried_duration, pair);
            })
            .catch(err => {
                this.busy = false;
                const raw = String(err?.message || 'Failed to place trade');
                if (/dropped/i.test(raw)) this.hooks?.onLog?.('error', 'The connection dropped while buying. Check Transactions: that contract may still be open.');
                const detail = `${candidate.contract_type} on ${candidate.symbol} for ${tried_duration} tick(s): ${raw}`;
                this.hooks?.onLog?.('error', detail);
                // Both sides whose winning payout would not cover the two stakes: not worth buying right now. Rest this contract
                // briefly (payouts move) and look for the next signal; nothing is marked as refused.
                if (typeof err?.rest === 'number') {
                    this.hooks?.onLog?.('info', `Skipped: ${raw}. Resting that contract and waiting for the next signal.`);
                    this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + err.rest);
                    if (this.step === 1) this.ladder_spent = 0; else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
                    setTimeout(() => this._findAndEnter(wanted_stake, tag), 500);
                    return;
                }
                if (err?.cover === true) {
                    this.hooks?.onLog?.('info', `Both sides skipped: ${raw}. Waiting for the next signal.`);
                    this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 60_000);
                    if (this.step === 1) this.ladder_spent = 0; else this.ladder_spent = Math.max(0, this.ladder_spent - stake);
                    setTimeout(() => this._findAndEnter(wanted_stake, tag), 500);
                    return;
                }
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

    /**
     * The 3-contract basket. All three `buy` requests are sent in the same event-loop tick with Promise.all. Each buy is wrapped so a refusal
     * of one comes back as a value instead of rejecting the whole Promise.all: a contract that DID get bought is never left unwatched.
     */
    private _enterBasket(candidate: TCandidate, wanted_total: number, tag?: TAutoPilotEvent['tag']) {
        const meta = candidate as { pair_key?: string; trend?: string; basket_direction?: string; momentum?: boolean; cover_digit?: number };
        const setup = basketSetup(meta.pair_key, meta.basket_direction ?? meta.trend, meta.momentum === true, this.config.basket_cover === true ? meta.cover_digit : undefined);
        const retry = (ms: number) => setTimeout(() => this._findAndEnter(wanted_total, tag), ms);
        if (!setup) {
            this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 5000);
            retry(500);
            return;
        }
        // The backend names the setup (1-16) it judged. If the AI would build a different one, the signal and the basket do not match: do not buy.
        const announced = (candidate as { basket_setup?: number | null }).basket_setup;
        if (announced !== undefined && announced !== setup.number) {
            this.hooks?.onLog?.('error', `Basket skipped on ${candidate.symbol}: the backend judged setup ${announced} but this signal builds setup ${setup.number}.`);
            this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 300_000);
            retry(500);
            return;
        }
        const min_total = basketMinTotal(setup.legs);
        const total = Number(Math.max(wanted_total, min_total).toFixed(2));
        if (total > wanted_total && this.step === 1) this.hooks?.onLog?.('info', `Basket total ${wanted_total} is too small for a ${Math.round(Math.min(...setup.legs.map(l => l.share)) * 100)}% contract (Deriv's minimum stake is ${MIN_LEG_STAKE}): using ${total} ${this.currency}.`);
        const live_balance = this.connection.accountInfo?.balance;
        if (typeof live_balance === 'number' && Number.isFinite(live_balance) && total > live_balance) {
            this.hooks?.onLog?.('error', `The basket total (${total} ${this.currency}) is more than the account balance (${live_balance.toFixed(2)}). Stopping.`);
            this.stop('balance is too low for the basket');
            return;
        }
        const stakes = basketStakes(total, setup.legs);
        let built: { leg: TBasketLeg; stake: number; cand: TCandidate; params: Record<string, unknown> }[];
        try {
            built = setup.legs.map((leg, i) => {
                const cand = {
                    ...candidate,
                    contract_type: leg.type,
                    label: leg.label,
                    duration_ticks: leg.ticks,
                    prediction: leg.type === 'DIGITOVER' ? 4 : leg.type === 'DIGITUNDER' ? 5 : leg.type === 'DIGITDIFF' ? leg.digit : undefined,
                    pair_with: undefined,
                    basis: `Basket setup ${setup.number}: ${setup.base} + ${setup.legs[2].label} (${setup.direction} ${setup.regime}).`,
                } as unknown as TCandidate;
                return { leg, stake: stakes[i], cand, params: buildTradeParameters(cand, stakes[i], this.currency) };
            });
        } catch (err) {
            // Not all three contracts can be built on this market (one is not offered): nothing was sent, no partial basket.
            const detail = err instanceof Error ? err.message : 'Could not build the basket';
            this.hooks?.onLog?.('info', `Basket skipped on ${candidate.symbol}: ${detail}`);
            this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 300_000);
            retry(500);
            return;
        }
        this.busy = true;
        this.lastCandidate = candidate;
        this.last_live_at = Date.now();
        this.entry_tag = tag;
        this._emit({ phase: 'entering', symbol: candidate.symbol, contract_type: candidate.contract_type, label: `Setup ${setup.number}: ${setup.base} + ${setup.legs[2].label}`, confidence: candidate.confidence, stake: total, tag });
        this.hooks?.onLog?.('info', `Basket setup ${setup.number} on ${candidate.symbol}: ${built.map(b => `${b.leg.label} ${b.stake}`).join(' + ')} = ${total} ${this.currency} (${setup.direction} ${setup.regime}, blind spot ${setup.blind}).`);
        const buyLeg = async (b: (typeof built)[number]) => {
            const t0 = Date.now();
            try {
                const res = await this.connection.send({ buy: '1', price: b.stake, parameters: b.params });
                this._noteBuy(Date.now() - t0);
                const id = res?.buy?.contract_id;
                if (!id) throw new Error('Buy did not return a contract id');
                return { ok: true as const, b, id: id as string };
            } catch (err) {
                return { ok: false as const, b, err };
            }
        };
        // The three sends start synchronously inside this one call: same event-loop tick.
        Promise.all(built.map(buyLeg)).then(results => {
            const bought = results.filter((r): r is Extract<(typeof results)[number], { ok: true }> => r.ok);
            const failed = results.filter(r => !r.ok);
            if (!bought.length) {
                const raw = String((failed[0] as { err?: { message?: string } })?.err?.message || 'Failed to place the basket');
                this.busy = false;
                this.hooks?.onLog?.('error', `Basket on ${candidate.symbol} not bought: ${raw}`);
                if (REFUSAL_PATTERN.test(raw) && this.refused < 8) {
                    this.refused += 1;
                    this.blocked.set(`${candidate.symbol}|${candidate.contract_type}`, Date.now() + 300_000);
                    retry(500);
                    return;
                }
                this._emit({ phase: 'error', symbol: candidate.symbol, error: raw });
                this.stop('trade placement failed');
                return;
            }
            for (const f of failed) this.hooks?.onLog?.('error', `${f.b.leg.label} could not be bought (${String((f as { err?: { message?: string } }).err?.message ?? 'refused')}): the basket runs with ${bought.length} of ${setup.legs.length} contracts.`);
            const pair: TPair = { pending: bought.length, profit: 0, stake: Number(bought.reduce((a, r) => a + r.b.stake, 0).toFixed(2)), basket: true, returned: 0, legs: bought.length, intended: wanted_total };
            this.ladder_spent = Number((this.ladder_spent + pair.stake).toFixed(2));
            for (const r of bought) this._watch(r.b.cand, r.b.stake, r.id, r.b.leg.ticks, pair);
        });
    }

    /** The basket's stake machine, run when the last of its contracts has settled. */
    private _basketNext(pair: TPair, candidate: TCandidate, net_profit: number, tag?: TAutoPilotEvent['tag']) {
        const base = this.config.stake;
        const intended = pair.intended ?? base;
        if (net_profit >= 0) {
            // Net profit (or break-even): back to the baseline total stake.
            this.lock = null;
            if (this.step > 1 || intended !== base) this.hooks?.onLog?.('success', `Basket net ${net_profit >= 0 ? '+' : ''}${net_profit.toFixed(2)}: total stake back to the base ${base}.`);
            this.step = 1;
            this._findAndEnter(base);
            return;
        }
        this._holdMarket(candidate); // a net loss is recovered on the same market and pair (if enabled)
        if ((pair.returned ?? 0) > 0) {
            // Partial loss: some contracts paid but the net is negative. The total stake stays flat.
            this.hooks?.onLog?.('info', `Partial loss (${pair.returned} of ${pair.legs} contracts paid, net ${net_profit.toFixed(2)}): total stake stays at ${intended}.`);
            this._findAndEnter(intended);
            return;
        }
        // Full sweep: every contract returned nothing. Total stake x multiplier for the next signal.
        const mult = Math.max(1, this.config.martingale_multiplier ?? DEFAULT_LOSS_MULTIPLIER);
        const max_steps = Math.max(1, Math.floor(this.config.max_steps ?? 4));
        const next = Number((intended * mult).toFixed(2));
        const room = Math.abs(this.config.stop_loss) + this.total_profit;
        if (this.step >= max_steps) {
            this.hooks?.onLog?.('info', `${this.step} full-sweep losses in a row: the ladder is full, total stake goes back to the base ${base}.`);
            this.lock = null;
        } else if (next > room) {
            this.hooks?.onLog?.('info', `Next total stake ${next} is more than the stop loss still allows (${room.toFixed(2)}): back to the base ${base}.`);
        } else {
            this.step += 1;
            this.hooks?.onLog?.('info', `Full sweep (all ${pair.legs} contracts returned 0): total stake x${mult} -> ${next} (step ${this.step} of ${max_steps}).`);
            this._findAndEnter(next, 'recovery');
            return;
        }
        this.step = 1;
        this._findAndEnter(base);
    }

    private _watch(candidate: TCandidate, stake: number, contract_id: string, duration: number, pair?: TPair) {
        const entry_step = this.step;
        const entry_tag = this.entry_tag;
        // Deriv validates contract_id as an integer; ids from Deriv are numbers, so a stringified one is turned back into a number.
        const cid = Number.isFinite(Number(contract_id)) ? Number(contract_id) : contract_id;
        const sub_id = this.connection.subscribe({ proposal_open_contract: 1, contract_id: cid }, (data, err) => {
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
            const ticks = describeTicks(candidate, contract as Record<string, unknown>);
            this.hooks?.onLog?.(won ? 'success' : 'error', `${won ? 'Won' : 'Lost'} ${Math.abs(profit).toFixed(2)} ${this.currency} on ${candidate.symbol} ${candidate.contract_type}: ${ticks.text}`);
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
                mode: stakeMode(this.config.recovery_mode),
                confidence: candidate.confidence,
                strategy: (candidate as { strategy?: string }).strategy,
                tag: entry_tag,
                signal_ticks: ticks.signal,
                entry_tick: ticks.entry,
                exit_tick: ticks.exit,
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
                if (pair.basket && Number(contract.sell_price ?? bought + profit) > 0) pair.returned = (pair.returned ?? 0) + 1; // this contract paid something back
                pair.pending -= 1;
                if (pair.pending > 0) return; // still waiting for the other side (busy stays on)
                net_profit = pair.profit;
                net_stake = pair.stake;
                if (pair.basket) this.hooks?.onLog?.(net_profit >= 0 ? 'success' : 'error', `Basket closed: net ${net_profit >= 0 ? '+' : ''}${net_profit.toFixed(2)} ${this.currency} on ${candidate.symbol} (${pair.returned} of ${pair.legs} contracts paid).`);
                else this.hooks?.onLog?.(net_profit > 0 ? 'success' : 'error', `Both sides closed: net ${net_profit >= 0 ? '+' : ''}${net_profit.toFixed(2)} ${this.currency} on ${candidate.symbol}.`);
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

            if (pair?.basket) {
                this._basketNext(pair, candidate, net_profit, entry_tag);
                return;
            }
            const mode = stakeMode(this.config.recovery_mode);
            const base_stake = this.config.stake;

            if (net_won) {
                this.consecutive_losses = 0;
                this.lock = null; // a win frees the AI to take the best entry on any market
                const next = (next_stake: number, tag?: TAutoPilotEvent['tag']) => this._findAndEnter(next_stake, tag);
                if (mode !== 'reverse') {
                    // Martingale and flat: a win NEVER raises the stake. After a loss ladder the stake goes back to the base stake.
                    if (mode === 'martingale' && this.step > 1) this.hooks?.onLog?.('success', `Win: stake goes back to the base stake ${base_stake}.`);
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
            this._holdMarket(candidate);

            if (mode === 'martingale') {
                // Martingale on loss only: next stake = the stake that just lost x the multiplier (default 1.5), at most max_steps in a row.
                const per = pair ? 2 : 1;
                const mult = Math.max(1, this.config.martingale_multiplier ?? DEFAULT_LOSS_MULTIPLIER);
                const max_steps = Math.max(1, Math.floor(this.config.max_steps ?? 4));
                const next_stake = Number(Math.max(base_stake, (net_stake / per) * mult).toFixed(2));
                const room = Math.abs(this.config.stop_loss) + this.total_profit; // what the stop loss still allows
                if (this.step >= max_steps) {
                    this.hooks?.onLog?.('info', `${this.step} losses in a row: the ladder is full, stake goes back to the base stake ${base_stake}.`);
                    this.lock = null;
                } else if (next_stake * per > room) {
                    this.hooks?.onLog?.('info', `Next stake ${next_stake} x${per} is more than the stop loss still allows (${room.toFixed(2)}): back to the base stake ${base_stake}.`);
                } else {
                    this.step += 1;
                    this.hooks?.onLog?.('info', `Loss: stake x${mult} -> ${next_stake} (step ${this.step} of ${max_steps}).`);
                    this._findAndEnter(next_stake, 'recovery');
                    return;
                }
                this.step = 1;
                this._findAndEnter(base_stake);
                return;
            }
            // Reverse martingale / flat: the stake does NOT go up after a loss: back to the base stake, and the next signal is bought as it arrives.
            this.step = 1;
            this._findAndEnter(base_stake);
        });
    }
}
