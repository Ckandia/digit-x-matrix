// How each Deriv contract behaves in TICKS. Deriv rejects a buy whose duration is outside
// what it offers ("Trading is not offered for this duration"), so the AI must know this
// before choosing. Two sources, live one wins:
//  1. LIVE: the backend asks Deriv (contracts_for) which tick durations each contract has
//     for each market (GET /api/contracts/:symbol).
//  2. BUILT-IN table below, used until live rules arrive or if Deriv doesn't answer.
// `null` means "not offered in ticks" (only minutes/days): the auto-pilot never picks it.
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
//  RESETCALL/PUT   Rise/Fall whose barrier resets. 5-10 ticks.
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

/** The AI never trades 1-tick contracts: its shortest time frame is 2 ticks (where the contract allows it). */
export const AI_MIN_TICKS = 2;

export const isTickTradable = (symbol: string, type: string) => tickRange(symbol, type) !== null;

/** Every whole tick duration Deriv accepts for this contract on this market. */
export const tickDurations = (symbol: string, type: string, floor = 1): number[] => {
    const r = tickRange(symbol, type);
    if (!r) return [];
    const start = Math.max(r.min, Math.min(floor, r.max)); // contracts fixed below the floor (none today) keep their only value
    return Array.from({ length: r.max - start + 1 }, (_, i) => start + i);
};

export const clampTicks = (symbol: string, type: string, wanted: number | undefined, floor = 1): number => {
    const r = tickRange(symbol, type);
    const w = Math.max(floor, Number(wanted) || floor);
    return r ? Math.min(r.max, Math.max(r.min, w)) : w;
};

/**
 * How lopsided the last 50 ticks were for the side a digit contract bets on. This is observed
 * history, not a forecast: the learner records results per bucket, so it can find out whether
 * following (or fading) a skew has actually paid on this account.
 */
export const skewBucket = (
    recent: { n50?: { n: number; even_pct: number; odd_pct: number; over5_pct: number; under5_pct: number } } | undefined,
    type: string
): string | undefined => {
    const w = recent?.n50;
    if (!w || w.n < 50) return undefined;
    const pct =
        type === 'DIGITEVEN' ? w.even_pct : type === 'DIGITODD' ? w.odd_pct : type === 'DIGITOVER' ? w.over5_pct : type === 'DIGITUNDER' ? w.under5_pct : undefined;
    if (pct === undefined) return undefined;
    return pct < 50 ? 'min' : pct < 60 ? 'flat' : pct < 70 ? 'lean' : 'strong';
};
