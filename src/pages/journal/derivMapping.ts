// Adapters between Deriv's data and the journal.
//
// One Deriv contract becomes one buy leg (the stake) and one sell leg (what came back), so the journal's
// round-trip engine reproduces Deriv's own profit to the cent, and the stake is the risk: a lost contract
// is R = -1, a win is R = payout/stake - 1.
import type { Execution } from './core';
import type { TJournalSource, TJournalTrade } from './types';

const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Splits a Deriv shortcode such as `CALL_R_100_1.95_1699999999_5T_S0P_0` into type, market and ticks. */
export const parseShortcode = (shortcode: unknown): { type?: string; symbol?: string; ticks?: number } => {
    if (typeof shortcode !== 'string' || !shortcode) return {};
    const parts = shortcode.split('_');
    const type = parts[0] || undefined;
    // The market is everything up to the payout (always written with decimals, e.g. 1.95) or the start epoch.
    let end = parts.findIndex((p, i) => i > 0 && (/^\d+\.\d+$/.test(p) || /^\d{9,}$/.test(p)));
    if (end < 0) end = parts.length;
    const symbol = parts.slice(1, end).join('_') || undefined;
    const ticks_part = parts.find(p => /^\d+T$/.test(p));
    return { type, symbol, ticks: ticks_part ? Number(ticks_part.slice(0, -1)) : undefined };
};

/** The login id the app has active right now (the AI stops itself if this changes mid-run). */
export const activeAccount = (): string => {
    try {
        return localStorage.getItem('active_loginid') || 'unknown';
    } catch {
        return 'unknown';
    }
};

/** A settled `proposal_open_contract` (Deriv's live contract shape) as a journal trade. Null while still open. */
export const fromContract = (c: Record<string, unknown>, source: TJournalSource, account = activeAccount()): TJournalTrade | null => {
    if (!c || !c.is_sold) return null;
    const id = String(c.contract_id ?? c.id ?? '');
    if (!id) return null;
    const stake = num(c.buy_price);
    if (!(stake > 0)) return null;
    const sell_price = c.sell_price !== undefined ? num(c.sell_price) : undefined;
    const profit = c.profit !== undefined ? num(c.profit) : sell_price !== undefined ? sell_price - stake : 0;
    const sc = parseShortcode(c.shortcode);
    const buy_s = num(c.date_start) || num(c.purchase_time);
    const sell_s = num(c.sell_time) || num(c.date_expiry);
    const now = Date.now();
    return {
        id,
        account,
        symbol: String(c.underlying ?? c.underlying_symbol ?? sc.symbol ?? 'unknown'),
        type: String(c.contract_type ?? sc.type ?? 'unknown'),
        stake: round2(stake),
        payout: round2(stake + profit),
        profit: round2(profit),
        buy_ts: buy_s ? buy_s * 1000 : sell_s ? sell_s * 1000 : now,
        sell_ts: sell_s ? sell_s * 1000 : now,
        ticks: c.tick_count ? num(c.tick_count) : sc.ticks,
        source,
    };
};

/** One row of Deriv's `profit_table` response (settled contracts) as a journal trade. */
export const fromProfitTableRow = (row: Record<string, unknown>, account = activeAccount()): TJournalTrade | null => {
    const id = String(row.contract_id ?? '');
    const stake = num(row.buy_price);
    if (!id || !(stake > 0)) return null;
    const sell_price = num(row.sell_price);
    const sc = parseShortcode(row.shortcode);
    const buy_s = num(row.purchase_time);
    const sell_s = num(row.sell_time);
    return {
        id,
        account,
        symbol: String(row.underlying_symbol ?? row.underlying ?? sc.symbol ?? 'unknown'),
        type: String(row.contract_type ?? sc.type ?? 'unknown'),
        stake: round2(stake),
        payout: round2(sell_price),
        profit: round2(sell_price - stake),
        buy_ts: buy_s ? buy_s * 1000 : sell_s * 1000,
        sell_ts: sell_s ? sell_s * 1000 : buy_s * 1000,
        ticks: sc.ticks,
        source: 'deriv',
    };
};

/** The journal-core input for a list of trades: a buy at the stake and a sell at what came back. */
export const toExecutions = (trades: TJournalTrade[]): Execution[] =>
    trades.flatMap(t => {
        const symbol = `${t.symbol} ${t.type}`;
        const buy = Math.min(t.buy_ts, t.sell_ts);
        return [
            {
                id: `${t.id}:b`,
                accountId: t.account,
                symbol,
                side: 'buy' as const,
                quantity: 1,
                price: t.stake,
                fee: 0,
                executedAt: new Date(buy).toISOString(),
                source: 'import' as const,
                // Each contract is its own position, so overlapping contracts on one market never net together.
                importMetadata: { id: `${t.id}:b`, group: t.id, order: 0 },
            },
            {
                id: `${t.id}:s`,
                accountId: t.account,
                symbol,
                side: 'sell' as const,
                quantity: 1,
                price: t.payout,
                fee: 0,
                executedAt: new Date(Math.max(t.sell_ts, buy + 1)).toISOString(),
                source: 'import' as const,
                importMetadata: { id: `${t.id}:s`, group: t.id, order: 1 },
            },
        ];
    });

/** Recovers the journal trade id from a round trip's first execution id. */
export const tradeIdOfExecution = (execution_id: string): string => execution_id.replace(/:[bs]$/, '');
