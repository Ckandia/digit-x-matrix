// Turns Deriv proposal_open_contract updates into the rows shown in the AI Trader tab.
export type TTradeRow = {
    id: string;
    ts: number; // epoch seconds
    symbol: string;
    type: string;
    shortcode: string;
    tick_count?: number;
    stake: number;
    profit: number;
    open: boolean;
};

export const getDurationTicks = (r: TTradeRow): number | undefined => {
    if (r.tick_count) return r.tick_count;
    const m = /_(\d+)T(?:_|$)/.exec(r.shortcode);
    return m ? Number(m[1]) : undefined;
};

/** Inserts or updates the row for this contract (newest first, capped at 100). */
export const mergeTradeRow = (rows: TTradeRow[], c: Record<string, unknown>): TTradeRow[] => {
    const id = String(c.contract_id ?? c.id ?? '');
    if (!id) return rows;
    const row: TTradeRow = {
        id,
        ts: Number(c.date_start ?? c.purchase_time ?? Math.floor(Date.now() / 1000)),
        symbol: String(c.underlying ?? c.display_name ?? ''),
        type: String(c.contract_type ?? ''),
        shortcode: String(c.shortcode ?? ''),
        tick_count: c.tick_count ? Number(c.tick_count) : undefined,
        stake: Number(c.buy_price ?? 0),
        profit: Number(c.profit ?? 0),
        open: !c.is_sold,
    };
    const i = rows.findIndex(r => r.id === id);
    if (i === -1) return [row, ...rows].slice(0, 100);
    const next = [...rows];
    next[i] = row;
    return next;
};
