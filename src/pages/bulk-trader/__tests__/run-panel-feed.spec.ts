// The run panel's totals (Summary / Transactions) must count the contracts the AI and Bulk Trades place, whatever fields
// the trading connection's contract objects carry.
import { forRunPanel } from '../contractFeed';
import { upsertContract } from '../serverRun';

describe('forRunPanel', () => {
    it('marks a sold contract with no status as ended, and groups its updates by one buy id', () => {
        const open = forRunPanel({ contract_id: 7, is_sold: 0, buy_price: 1, profit: 0 });
        const won = forRunPanel({ contract_id: 7, is_sold: 1, buy_price: 1, profit: 0.83, sell_price: 1.83 });
        const lost = forRunPanel({ contract_id: 8, is_sold: 1, buy_price: 1, profit: -1 });
        expect(open.status).toBe('open');
        expect(won.status).toBe('won');
        expect(lost.status).toBe('lost');
        expect((won.transaction_ids as { buy: unknown }).buy).toBe(7);
        expect(won.id).toBe(7);
        expect(won.payout).toBe(1.83);
    });

    it('keeps what Deriv already sent', () => {
        const c = forRunPanel({ contract_id: 9, id: 9, status: 'sold', is_sold: 1, profit: 0.2, transaction_ids: { buy: 55, sell: 56 }, payout: 2 });
        expect(c.status).toBe('sold');
        expect(c.transaction_ids).toEqual({ buy: 55, sell: 56 });
        expect(c.payout).toBe(2);
    });
});

describe('server run contracts', () => {
    it('keeps one trimmed row per contract, newest first, and updates it when it settles', () => {
        let rows: Record<string, unknown>[] = [];
        rows = upsertContract(rows, { contract_id: 1, is_sold: 0, profit: 0, big_unneeded_field: 'x'.repeat(1000) });
        rows = upsertContract(rows, { contract_id: 2, is_sold: 0, profit: 0 });
        rows = upsertContract(rows, { contract_id: 1, is_sold: 1, profit: 0.83 });
        expect(rows.map(r => r.contract_id)).toEqual([2, 1]);
        expect(rows[1].is_sold).toBe(1);
        expect('big_unneeded_field' in rows[1]).toBe(false);
        for (let i = 10; i < 100; i++) rows = upsertContract(rows, { contract_id: i });
        expect(rows.length).toBe(40);
    });
});
