// The AI's self-evaluation: it reads its own trade history from the journal and judges what it did.
//
// What it answers, from real results:
//   1. Which market + contract combinations are clearly losing / clearly winning / still unproven?
//   2. Did growing the stake after wins (reverse martingale) help or cost money, against flat staking?
//   3. Does a higher signal confidence actually lead to better results?
//
// How it judges. Every trade is scored in R: profit divided by stake (a loss is -1, a win is
// payout/stake - 1). The average R of a combination, with its standard error, says whether the result is
// different from break-even by more than luck:
//   - 'losing'       average R is below zero by about 2 standard errors (95%)  -> the AI skips it
//   - 'lagging'      average R is below zero by about 1 standard error          -> ranked lower, not skipped
//   - 'winning'      average R is above zero by about 2 standard errors
//   - 'inconclusive' anything else with enough trades
//   - 'too_few'      fewer than MIN_TRADES results, so no verdict yet
// Because R does not depend on stake size, growing the stake never distorts a verdict.
//
// HONEST LIMIT. With payouts near 1.9x a combination needs roughly a 52% hit rate to break even. Telling a
// true 50% from a true 55% takes hundreds of trades, so most combinations stay 'inconclusive' for a long
// time. This module can only find results that are clearly bad or clearly good; it cannot create an edge,
// and a 'winning' verdict is evidence about the past, not a promise.
import type { TJournalTrade } from './types';

export const MIN_TRADES = 30;
/** Z for ~95% confidence ('losing' / 'winning') and ~84% ('lagging'). */
const Z_STRONG = 1.96;
const Z_SOFT = 1.0;
/** A lagging combination keeps this share of its signal confidence when the AI ranks candidates. */
export const WATCH_CONFIDENCE_FACTOR = 0.6;
/** Only the latest AI trades are reviewed, so a market that has changed is judged on how it behaves now. */
const REVIEW_WINDOW = 1000;

export type TVerdict = 'too_few' | 'inconclusive' | 'lagging' | 'losing' | 'winning';

export type TCellReview = {
    /** `symbol|type` (+ `@strategy`), or `*|type` (+ `@strategy`) for a contract type across all markets. */
    key: string;
    label: string;
    symbol?: string;
    type: string;
    strategy?: string;
    n: number;
    wins: number;
    win_rate: number;
    /** The hit rate this combination needs to break even at the payouts it actually received. Null with no wins yet. */
    break_even: number | null;
    mean_r: number;
    se_r: number;
    net: number;
    verdict: TVerdict;
};

export type TReviewGate = {
    /** Keys the AI must not trade right now. */
    blocked: ReadonlySet<string>;
    /** Keys the AI still trades, but ranks lower. */
    watch: ReadonlySet<string>;
};

export type TSelfReview = {
    generated_at: number;
    account: string;
    /** AI trades reviewed (the latest REVIEW_WINDOW). */
    trades: number;
    net: number;
    win_rate: number | null;
    cells: TCellReview[];
    types: TCellReview[];
    blocked: TCellReview[];
    watch: TCellReview[];
    winning: TCellReview[];
    stake: {
        /** Trades placed above the base stake (a growing win streak or a recovery step). */
        raised_trades: number;
        actual_net: number;
        /** What the same trades would have made at the base stake. */
        flat_net: number;
        /** actual - flat. Positive means the stake changes added money, negative means they cost money. */
        effect: number;
    } | null;
    calibration: { band: string; n: number; win_rate: number; mean_r: number }[];
    /** Plain-language findings, shown in the Journal tab and logged when the AI starts. */
    lines: string[];
    gate: TReviewGate;
};

export const cellKey = (symbol: string, type: string, strategy?: string): string => `${symbol}|${type}${strategy ? `@${strategy}` : ''}`;
export const typeKey = (type: string, strategy?: string): string => cellKey('*', type, strategy);

const r_of = (t: TJournalTrade): number => (t.stake > 0 ? t.profit / t.stake : 0);

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stderr = (xs: number[]): number => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    const variance = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
    return Math.sqrt(variance / xs.length);
};
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export const verdictOf = (n: number, mean_r: number, se_r: number): TVerdict => {
    if (n < MIN_TRADES) return 'too_few';
    if (mean_r + Z_STRONG * se_r < 0) return 'losing';
    if (mean_r - Z_STRONG * se_r > 0) return 'winning';
    if (mean_r + Z_SOFT * se_r < 0) return 'lagging';
    return 'inconclusive';
};

const reviewCell = (key: string, trades: TJournalTrade[], symbol: string | undefined, type: string, strategy?: string): TCellReview => {
    const rs = trades.map(r_of);
    const wins = trades.filter(t => t.profit > 0);
    const win_r = wins.map(r_of);
    const mean_r = mean(rs);
    const se_r = stderr(rs);
    return {
        key,
        label: `${symbol ?? 'All markets'} ${type}${strategy ? ` (${strategy.replace('_', ' ')})` : ''}`,
        symbol,
        type,
        strategy,
        n: trades.length,
        wins: wins.length,
        win_rate: trades.length ? wins.length / trades.length : 0,
        break_even: win_r.length ? 1 / (1 + mean(win_r)) : null,
        mean_r: round(mean_r),
        se_r: round(se_r),
        net: round(trades.reduce((a, t) => a + t.profit, 0), 2),
        verdict: verdictOf(trades.length, mean_r, se_r),
    };
};

const group = <T,>(items: T[], keyOf: (t: T) => string): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const it of items) {
        const k = keyOf(it);
        const g = m.get(k);
        if (g) g.push(it);
        else m.set(k, [it]);
    }
    return m;
};

const BANDS: { band: string; lo: number; hi: number }[] = [
    { band: '0-39', lo: 0, hi: 40 },
    { band: '40-59', lo: 40, hi: 60 },
    { band: '60-79', lo: 60, hi: 80 },
    { band: '80-100', lo: 80, hi: 101 },
];

/** Builds the AI's review of its own trades. Only trades the AI placed (source 'ai') are judged. */
export const buildSelfReview = (all_trades: TJournalTrade[], account: string, now = Date.now()): TSelfReview => {
    const ai = all_trades
        .filter(t => t.source === 'ai' && t.stake > 0)
        .sort((a, b) => a.sell_ts - b.sell_ts)
        .slice(-REVIEW_WINDOW);

    const strategyOf = (t: TJournalTrade) => t.ai?.strategy;
    const cells = [...group(ai, t => cellKey(t.symbol, t.type, strategyOf(t))).entries()]
        .map(([key, g]) => reviewCell(key, g, g[0]!.symbol, g[0]!.type, strategyOf(g[0]!)))
        .sort((a, b) => b.n - a.n);
    const types = [...group(ai, t => typeKey(t.type, strategyOf(t))).entries()]
        .map(([key, g]) => reviewCell(key, g, undefined, g[0]!.type, strategyOf(g[0]!)))
        .sort((a, b) => b.n - a.n);

    const judged = [...cells, ...types];
    const blocked = judged.filter(c => c.verdict === 'losing');
    const watch = judged.filter(c => c.verdict === 'lagging');
    const winning = judged.filter(c => c.verdict === 'winning');

    // Did raising the stake help? Compare with the same trades at the session's base stake.
    const with_ctx = ai.filter(t => t.ai && t.ai.base_stake > 0);
    const raised = with_ctx.filter(t => t.stake > t.ai!.base_stake * 1.001);
    const stake =
        raised.length >= 5
            ? (() => {
                  const actual = with_ctx.reduce((a, t) => a + t.profit, 0);
                  const flat = with_ctx.reduce((a, t) => a + r_of(t) * t.ai!.base_stake, 0);
                  return {
                      raised_trades: raised.length,
                      actual_net: round(actual, 2),
                      flat_net: round(flat, 2),
                      effect: round(actual - flat, 2),
                  };
              })()
            : null;

    // Does a higher confidence score lead to better results?
    const calibration = BANDS.map(b => {
        const g = ai.filter(t => t.ai && t.ai.confidence >= b.lo && t.ai.confidence < b.hi);
        return { band: b.band, n: g.length, win_rate: g.length ? g.filter(t => t.profit > 0).length / g.length : 0, mean_r: round(mean(g.map(r_of))) };
    }).filter(b => b.n > 0);

    const net = round(ai.reduce((a, t) => a + t.profit, 0), 2);
    const win_rate = ai.length ? ai.filter(t => t.profit > 0).length / ai.length : null;
    const all_wins_r = ai.filter(t => t.profit > 0).map(r_of);
    const overall_be = all_wins_r.length ? 1 / (1 + mean(all_wins_r)) : null;

    const pct = (x: number) => `${Math.round(x * 100)}%`;
    // A contract type that is flagged across all markets already covers its single-market rows: say it once.
    const distinct = (list: TCellReview[]) =>
        list.filter(c => c.symbol === undefined || !list.some(o => o.symbol === undefined && o.type === c.type && o.strategy === c.strategy));
    const names = (list: TCellReview[]) => {
        const shown = list.slice(0, 4).map(c => c.label);
        return shown.join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : '');
    };
    const lines: string[] = [];
    if (ai.length < MIN_TRADES) {
        lines.push(`Only ${ai.length} AI trade${ai.length === 1 ? '' : 's'} on file. The self-review starts judging a market and contract once it has ${MIN_TRADES} results for it.`);
    } else {
        lines.push(
            `Reviewed ${ai.length} AI trades: net ${net >= 0 ? '+' : ''}${net.toFixed(2)}, hit rate ${pct(win_rate ?? 0)}${overall_be ? ` (break-even is about ${pct(overall_be)})` : ''}.`
        );
        const b = distinct(blocked);
        const w = distinct(watch).filter(c => !blocked.some(x => x.key === c.key));
        const g = distinct(winning);
        if (b.length) lines.push(`Skipping ${b.length} combination${b.length === 1 ? '' : 's'} with clearly negative results: ${names(b)}.`);
        if (w.length) lines.push(`${w.length} more ${w.length === 1 ? 'is' : 'are'} lagging and ranked lower: ${names(w)}.`);
        if (g.length) lines.push(`Clearly profitable so far: ${names(g)}. That is evidence about the past, not a promise.`);
        if (!b.length && !w.length && !g.length) {
            lines.push('No combination is proven either way yet. At ~1.9x payouts, telling a 50% hit rate from a profitable one takes hundreds of trades per combination.');
        }
    }
    if (stake) {
        lines.push(
            stake.effect < 0
                ? `Raising the stake on ${stake.raised_trades} trades cost ${Math.abs(stake.effect).toFixed(2)} compared with staking the base amount every time.`
                : `Raising the stake on ${stake.raised_trades} trades added ${stake.effect.toFixed(2)} compared with staking the base amount every time.`
        );
    }
    const first = calibration[0];
    const last = calibration[calibration.length - 1];
    if (calibration.length >= 2 && first && last && first.n >= 20 && last.n >= 20) {
        lines.push(
            last.mean_r > first.mean_r
                ? `Higher-confidence signals (${last.band}) did better than low-confidence ones (${first.band}).`
                : `Confidence is not predicting results: signals scored ${last.band} did no better than ${first.band}.`
        );
    }

    return {
        generated_at: now,
        account,
        trades: ai.length,
        net,
        win_rate,
        cells,
        types,
        blocked,
        watch,
        winning,
        stake,
        calibration,
        lines,
        gate: { blocked: new Set(blocked.map(c => c.key)), watch: new Set(watch.map(c => c.key)) },
    };
};

// ---- Applying the review to the AI's candidate signals ----------------------------------------------------

type TSignalLike = { contract_type: string; confidence: number; strategy?: string };
type TSnapshotLike<S extends TSignalLike> = { signals: S[] };

/** True when the AI must not trade this market + contract right now. */
export const isBlocked = (gate: TReviewGate | undefined, symbol: string, type: string, strategy?: string): boolean =>
    !!gate && (gate.blocked.has(cellKey(symbol, type, strategy)) || gate.blocked.has(typeKey(type, strategy)));

/** Removes blocked signals and ranks lagging ones lower. Everything else passes through untouched. */
export const applyGate = <S extends TSignalLike, T extends TSnapshotLike<S>>(snapshots: Record<string, T>, gate: TReviewGate | undefined): Record<string, T> => {
    if (!gate || (gate.blocked.size === 0 && gate.watch.size === 0)) return snapshots;
    const out: Record<string, T> = {};
    for (const [symbol, snap] of Object.entries(snapshots)) {
        const signals: S[] = [];
        for (const s of snap.signals) {
            if (isBlocked(gate, symbol, s.contract_type, s.strategy)) continue;
            const lagging = gate.watch.has(cellKey(symbol, s.contract_type, s.strategy)) || gate.watch.has(typeKey(s.contract_type, s.strategy));
            signals.push(lagging ? { ...s, confidence: Math.round(s.confidence * WATCH_CONFIDENCE_FACTOR) } : s);
        }
        out[symbol] = { ...snap, signals };
    }
    return out;
};
