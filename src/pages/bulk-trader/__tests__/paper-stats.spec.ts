import { poolByContract, TPaperReport } from '../paperStats';

const report = (rows: Record<string, [number, number]>): TPaperReport => ({
    started_at: new Date().toISOString(),
    total_paper_trades: 0,
    breakeven_win_rate: 0.5495,
    payout_ratio_assumed: 0.82,
    hook: { after_loss: { n: 0, wins: 0, win_rate: 0 }, after_win: { n: 0, wins: 0, win_rate: 0 } },
    cells: Object.entries(rows).map(([contract_type, [n, wins]]) => ({
        symbol: 'R_10', contract_type, n, wins, win_rate: wins / n, low: 0, recent_n: 0, recent_win_rate: 0, ctx: {},
    })),
});

describe('poolByContract', () => {
    it('does not call a 50% contract an edge, however many trades it has', () => {
        const rows = poolByContract(report({ DIGITEVEN: [100000, 50000] }));
        expect(rows[0].proven).toBe(false);
    });
    it('calls a clearly profitable contract proven only with enough trades', () => {
        expect(poolByContract(report({ DIGITODD: [5000, 3100] }))[0].proven).toBe(true);
        expect(poolByContract(report({ DIGITODD: [100, 65] }))[0].proven).toBe(false);
    });
});
