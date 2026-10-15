import { journalStore } from '../journalStore';

const trade = (id: string, ago_ms: number) => ({
    id,
    account: 'VRTC77',
    symbol: 'R_100',
    type: 'DIGITEVEN',
    stake: 1,
    payout: 1.9,
    profit: 0.9,
    buy_ts: Date.now() - ago_ms,
    sell_ts: Date.now() - ago_ms + 1000,
    source: 'ai' as const,
});

describe('journal: clear transactions', () => {
    beforeEach(() => {
        localStorage.clear();
        journalStore._resetMemory();
    });

    it('clears only trades older than the chosen age', () => {
        journalStore.addMany([trade('new', 1000), trade('old', 30 * 3600_000), trade('older', 40 * 3600_000)]);
        const removed = journalStore.clear('VRTC77', 24 * 3600_000);
        expect(removed).toBe(2);
        expect(journalStore.trades('VRTC77').map(t => t.id)).toEqual(['new']);
    });

    it('clears everything when no age is given', () => {
        journalStore.addMany([trade('a', 1000), trade('b', 5000)]);
        expect(journalStore.clear('VRTC77')).toBe(2);
        expect(journalStore.trades('VRTC77')).toHaveLength(0);
    });

    it('does not bring cleared trades back when they are synced again, but keeps new ones', () => {
        journalStore.addMany([trade('old', 30 * 3600_000)]);
        journalStore.clear('VRTC77', 24 * 3600_000);
        journalStore.addMany([trade('old', 30 * 3600_000)]); // Sync from Deriv returns it again
        expect(journalStore.trades('VRTC77')).toHaveLength(0);
        journalStore.addMany([trade('fresh', 500)]);
        expect(journalStore.trades('VRTC77').map(t => t.id)).toEqual(['fresh']);
    });

    it('does not touch other accounts', () => {
        journalStore.addMany([trade('mine', 30 * 3600_000), { ...trade('other', 30 * 3600_000), account: 'CR1' }]);
        journalStore.clear('VRTC77');
        expect(journalStore.trades('CR1')).toHaveLength(1);
    });
});
