// Everything the Journal tab shows, computed with the vendored journal-core engine.
import {
    AnnotatedTrade,
    buildRoundTrips,
    calendarMonthFromDays,
    computeEdgeScore,
    computeMetrics,
    dailyStats,
    drawdown,
    equityCurve,
    hourOf,
    type CalendarMonth,
    type DayStats,
    type EdgeScore,
    type EquityPoint,
    type TradeMetrics,
} from './core';
import { toExecutions } from './derivMapping';
import type { TJournalTrade } from './types';

export type TPeriod = 'today' | '7d' | '30d' | 'all';
export type TFilters = { period: TPeriod; source: 'all' | 'ai'; symbol: string; type: string };
export const DEFAULT_FILTERS: TFilters = { period: 'all', source: 'all', symbol: 'all', type: 'all' };

export type TBreakdownRow = {
    key: string;
    trades: number;
    wins: number;
    win_rate: number | null;
    net: number;
    profit_factor: number | null;
    avg_r: number | null;
};

export type TAnalytics = {
    trades: TJournalTrade[];
    metrics: TradeMetrics;
    edge: EdgeScore;
    equity: EquityPoint[];
    max_drawdown: number;
    days: DayStats[];
    by_type: TBreakdownRow[];
    by_symbol: TBreakdownRow[];
    by_hour: TBreakdownRow[];
    by_step: TBreakdownRow[];
    by_strategy: TBreakdownRow[];
};

export const localTimeZone = (): string => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
};

const DAY_MS = 86_400_000;

export const periodStart = (period: TPeriod, now = new Date()): number => {
    if (period === 'all') return 0;
    if (period === 'today') {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }
    return now.getTime() - (period === '7d' ? 7 : 30) * DAY_MS;
};

export const filterTrades = (trades: TJournalTrade[], f: TFilters, now = new Date()): TJournalTrade[] => {
    const since = periodStart(f.period, now);
    return trades.filter(
        t =>
            t.sell_ts >= since &&
            (f.source === 'all' || t.source === 'ai') &&
            (f.symbol === 'all' || t.symbol === f.symbol) &&
            (f.type === 'all' || t.type === f.type)
    );
};

const breakdown = (trades: TJournalTrade[], keyOf: (t: TJournalTrade) => string | null): TBreakdownRow[] => {
    const groups = new Map<string, TJournalTrade[]>();
    for (const t of trades) {
        const k = keyOf(t);
        if (k === null) continue;
        const g = groups.get(k);
        if (g) g.push(t);
        else groups.set(k, [t]);
    }
    return [...groups.entries()]
        .map(([key, g]) => {
            const gain = g.reduce((a, t) => a + Math.max(0, t.profit), 0);
            const loss = g.reduce((a, t) => a - Math.min(0, t.profit), 0);
            const wins = g.filter(t => t.profit > 0).length;
            return {
                key,
                trades: g.length,
                wins,
                win_rate: g.length ? wins / g.length : null,
                net: Math.round(g.reduce((a, t) => a + t.profit, 0) * 100) / 100,
                profit_factor: loss > 0 ? gain / loss : null,
                avg_r: g.length ? g.reduce((a, t) => a + (t.stake > 0 ? t.profit / t.stake : 0), 0) / g.length : null,
            };
        })
        .sort((a, b) => b.net - a.net);
};

/** Runs the trades through the journal engine and prepares every breakdown the tab shows. */
export const buildAnalytics = (trades: TJournalTrade[], timeZone = localTimeZone(), initialBalance = 0): TAnalytics => {
    const trips = buildRoundTrips(toExecutions(trades));
    // The stake is the most a contract can lose, so a stop at a zero payout gives exact R-multiples.
    const annotated: AnnotatedTrade[] = trips.map(r => ({ ...r, annotations: { stopLoss: 0 } }));
    const metrics = computeMetrics(annotated, { timeZone, initialBalance });
    const equity = equityCurve(trips);
    return {
        trades,
        metrics,
        edge: computeEdgeScore(metrics),
        equity,
        max_drawdown: drawdown(equity, initialBalance).maxDrawdown,
        days: dailyStats(trips, timeZone),
        by_type: breakdown(trades, t => t.type),
        by_symbol: breakdown(trades, t => t.symbol),
        by_hour: breakdown(trades, t => String(hourOf(new Date(t.sell_ts).toISOString(), timeZone)).padStart(2, '0') + ':00').sort((a, b) =>
            a.key.localeCompare(b.key)
        ),
        by_step: breakdown(trades.filter(t => t.ai), t => `Step ${t.ai!.step}`).sort((a, b) => a.key.localeCompare(b.key)),
        by_strategy: breakdown(trades.filter(t => t.ai), t => (t.ai!.strategy ? t.ai!.strategy.replace('_', ' ') : 'plain signal')),
    };
};

export const monthOf = (days: DayStats[], year: number, month: number): CalendarMonth => calendarMonthFromDays(days, year, month);

/** The journal as CSV (opens in Excel / Google Sheets). */
export const toCsv = (trades: TJournalTrade[]): string => {
    const head = ['contract_id', 'account', 'closed_at', 'market', 'contract', 'stake', 'payout', 'profit', 'ticks', 'source', 'stake_step', 'strategy', 'confidence'];
    const rows = trades.map(t =>
        [
            t.id,
            t.account,
            new Date(t.sell_ts).toISOString(),
            t.symbol,
            t.type,
            t.stake,
            t.payout,
            t.profit,
            t.ticks ?? '',
            t.source,
            t.ai?.step ?? '',
            t.ai?.strategy ?? '',
            t.ai?.confidence ?? '',
        ].join(',')
    );
    return [head.join(','), ...rows].join('\n');
};
