// What the backend's 24/7 paper trader has seen (see backend/src/paperTrader.js). Aggregates only.
const rest_base = (process.env.NEXT_PUBLIC_BULK_TRADER_API_URL || '').trim().replace(/\/$/, '');

export type TPaperCtx = { n: number; wins: number; win_rate: number; low: number };
export type TPaperCell = {
    symbol: string;
    contract_type: string;
    n: number;
    wins: number;
    win_rate: number;
    low: number;
    recent_n: number;
    recent_win_rate: number;
    ctx: Record<string, TPaperCtx>;
};
export type TPaperVerdict = 'collecting' | 'edge' | 'loses' | 'no_edge' | 'no_payout';
export type TPaperContract = {
    contract_type: string;
    n: number;
    wins: number;
    win_rate: number;
    low: number;
    high: number;
    /** Net profit per 1 staked on a win, as really quoted by Deriv (null until the backend has a quote). */
    payout_ratio: number | null;
    breakeven: number | null;
    /** Expected result per 1 staked, with its 95% range. */
    ev: number | null;
    ev_low: number | null;
    ev_high: number | null;
    verdict: TPaperVerdict;
    hook: { after_win: { n: number; wins: number; win_rate: number }; after_loss: { n: number; wins: number; win_rate: number } };
};
export type TPaperEdge = { symbol: string; contract_type: string; ctx: string; n: number; win_rate: number; breakeven: number; z: number; ev: number };
export type TPaperReport = {
    /** Added by the newer backend: real payouts, per-contract verdicts, the edge search. Absent on an older backend. */
    contracts?: TPaperContract[];
    edges?: TPaperEdge[];
    edge_search?: { tested: number; z_needed: number | null; best: TPaperEdge[] };
    hook_within?: { diff: number; z: number };
    started_at: string;
    total_paper_trades: number;
    breakeven_win_rate: number;
    payout_ratio_assumed: number;
    hook: { after_loss: { n: number; wins: number; win_rate: number }; after_win: { n: number; wins: number; win_rate: number } };
    cells: TPaperCell[];
};

/** Contracts whose payout is a steady ~1.8x, so a pooled win rate can be compared with one break-even. */
export const ONE_TICK_PAPER_TYPES = ['DIGITEVEN', 'DIGITODD', 'DIGITOVER', 'DIGITUNDER', 'CALL', 'PUT'];

export const fetchPaperReport = async (): Promise<TPaperReport | null> => {
    if (!rest_base) return null;
    try {
        const res = await fetch(`${rest_base}/api/paper/stats`);
        if (!res.ok) return null;
        const { data } = await res.json();
        return data as TPaperReport;
    } catch {
        return null;
    }
};

export type TPooledContract = { contract_type: string; n: number; wins: number; win_rate: number; low: number; proven: boolean };

const wilsonLow = (n: number, wins: number) => {
    if (!n) return 0;
    const z = 1.96;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return Math.max(0, (centre - margin) / denom);
};

/** Every market pooled, one row per contract: this is the number the AI compares with the payout's break-even. */
export const poolByContract = (report: TPaperReport): TPooledContract[] => {
    const out = new Map<string, { n: number; wins: number }>();
    for (const c of report.cells) {
        const r = out.get(c.contract_type) || { n: 0, wins: 0 };
        r.n += c.n;
        r.wins += c.wins;
        out.set(c.contract_type, r);
    }
    return [...out.entries()]
        .map(([contract_type, r]) => {
            const low = wilsonLow(r.n, r.wins);
            return {
                contract_type,
                n: r.n,
                wins: r.wins,
                win_rate: r.n ? r.wins / r.n : 0,
                low,
                proven: r.n >= 300 && low > report.breakeven_win_rate,
            };
        })
        .sort((a, b) => b.win_rate - a.win_rate);
};

/** Contracts the backend has PROVEN to beat their real payout (95% confidence). Empty = none, which is what a fair-odds game gives. */
export const provenContracts = (report: TPaperReport | null | undefined): string[] =>
    (report?.contracts ?? []).filter(c => c.verdict === 'edge').map(c => c.contract_type);
