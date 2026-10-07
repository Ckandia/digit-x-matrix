// How each Deriv contract behaves in TICKS. Deriv rejects a buy whose duration is outside
// what it offers ("Trading is not offered for this duration"), so the AI must know this
// before choosing. Two sources, live one wins:
//  1. LIVE: the backend asks Deriv (contracts_for) which tick durations each contract has
//     for each market (GET /api/contracts/:symbol).
//  2. BUILT-IN table below, used until live rules arrive or if Deriv doesn't answer.
// `null` means "not offered in ticks" (only minutes/days): the auto-pilot never picks it.
//
// TRADING RULE (tradeTicks below): every contract is bought for exactly 1 tick, except the
// barrier contracts (Touch/No Touch, Ends Between/Outside), which use the shortest duration
// Deriv offers for them. A non-barrier contract Deriv does not offer at 1 tick (Asians, Only
// Ups/Downs, High/Low Tick, Reset) is never traded: Deriv would reject it, and stretching it to
// a longer duration would break the 1-tick rule.
//
// Contract mechanics the AI trades (all payout fixed at purchase):
//  CALL/PUT        Rise/Fall: exit above/below entry. 1-10 ticks.
//  DIGITEVEN/ODD   parity of the last digit of the exit tick. 1-10 ticks.
//  DIGITOVER/UNDER last digit above/below a chosen barrier digit. 1-10 ticks.
//  ASIANU/ASIAND   exit vs the AVERAGE of all ticks in the trade. 5-10 ticks.
//  RUNHIGH/RUNLOW  Only Ups/Only Downs: EVERY tick must rise/fall. 2-5 ticks. High payout, low chance.
//  TICKHIGH/LOW    pick which of 5 ticks is the highest/lowest. Fixed 5 ticks.
//  ONETOUCH/NOTOUCH price touches / never touches a barrier. 5-10 ticks.
//  EXPIRYRANGE/MISS Ends Between/Outside: exit inside/outside two barriers. NOT offered in ticks.
//  RANGE/UPORDOWN  Stays Between/Goes Outside: price stays inside / leaves two barriers at any tick.
//  RESETCALL/PUT   Rise/Fall whose barrier resets. 5-10 ticks.
import { isBarrierContract } from './tradingKnowledge';

export type TTickRange = { min: number; max: number } | null;
type TRules = Record<string, TTickRange>;

const BUILT_IN: TRules = {
    CALL: { min: 1, max: 10 },
    PUT: { min: 1, max: 10 },
    DIGITEVEN: { min: 1, max: 10 },
    DIGITODD: { min: 1, max: 10 },
    DIGITOVER: { min: 1, max: 10 },
    DIGITUNDER: { min: 1, max: 10 },
    ASIANU: { min: 5, max: 10 },
    ASIAND: { min: 5, max: 10 },
    RUNHIGH: { min: 2, max: 5 },
    RUNLOW: { min: 2, max: 5 },
    TICKHIGH: { min: 5, max: 5 },
    TICKLOW: { min: 5, max: 5 },
    ONETOUCH: { min: 5, max: 10 },
    NOTOUCH: { min: 5, max: 10 },
    RESETCALL: { min: 5, max: 10 },
    RESETPUT: { min: 5, max: 10 },
    EXPIRYRANGE: null,
    EXPIRYMISS: null,
    // Stays Between / Goes Outside: treated as not-in-ticks until Deriv's live rules (contracts_for)
    // show a tick duration for them. Until then the AI will not buy them.
    RANGE: null,
    UPORDOWN: null,
};

const rest_base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').trim().replace(/\/$/, '');
const live: Record<string, TRules | null> = {};

export const loadLiveRules = async (symbols: string[]) => {
    if (!rest_base) return;
    await Promise.all(
        symbols
            .filter(s => !(s in live))
            .map(async symbol => {
                try {
                    const res = await fetch(`${rest_base}/api/contracts/${symbol}`);
                    const body = res.ok ? await res.json() : null;
                    live[symbol] = body?.rules ?? null;
                } catch {
                    live[symbol] = null; // keep using the built-in table
                }
            })
    );
};

export const tickRange = (symbol: string, type: string): TTickRange => {
    const l = live[symbol];
    if (l && type in l) return l[type];
    return type in BUILT_IN ? BUILT_IN[type] : null; // unknown contract: never guess a duration
};

// Combinations Deriv refused at runtime (symbol|type -> when). Shared by the learner and by the
// engine in every learning mode, so a refused combination is skipped for 6 hours.
const refused: Record<string, number> = {};
const REFUSED_MS = 6 * 3600_000;
export const markRefused = (symbol: string, type: string) => {
    refused[`${symbol}|${type}`] = Date.now();
};
const isRefused = (symbol: string, type: string) => {
    const at = refused[`${symbol}|${type}`];
    return !!at && Date.now() - at < REFUSED_MS;
};

/**
 * THE duration the AI trades this contract for, in ticks, or null if it must not be traded:
 *  - barrier contracts: the shortest tick duration Deriv offers (null if not offered in ticks);
 *  - every other contract: exactly 1 tick, only if Deriv offers 1 tick for it on this market.
 * Null also while the combination is in the 6-hour refused list.
 */
export const tradeTicks = (symbol: string, type: string): number | null => {
    const r = tickRange(symbol, type);
    if (!r || isRefused(symbol, type)) return null;
    if (isBarrierContract(type)) return r.min; // which contracts need a barrier comes from the owner's notes (tradingKnowledge.ts)
    return r.min <= 1 && r.max >= 1 ? 1 : null;
};

export const isTickTradable = (symbol: string, type: string) => tradeTicks(symbol, type) !== null;

/**
 * How lopsided the last 50 ticks were for the side a digit contract bets on. This is observed
 * history, not a forecast: the learner records results per bucket, so it can find out whether
 * following (or fading) a skew has actually paid on this account.
 */
export const skewBucket = (
    recent: { n50?: { n: number; even_pct: number; odd_pct: number; over4_pct?: number; over5_pct: number; under5_pct: number } } | undefined,
    type: string
): string | undefined => {
    const w = recent?.n50;
    if (!w || w.n < 50) return undefined;
    const pct =
        type === 'DIGITEVEN' ? w.even_pct : type === 'DIGITODD' ? w.odd_pct : type === 'DIGITOVER' ? w.over4_pct ?? w.over5_pct : type === 'DIGITUNDER' ? w.under5_pct : undefined;
    if (pct === undefined) return undefined;
    return pct < 50 ? 'min' : pct < 60 ? 'flat' : pct < 70 ? 'lean' : 'strong';
};
