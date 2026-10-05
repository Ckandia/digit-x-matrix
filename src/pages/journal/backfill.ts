// Pulls your settled contracts from your Deriv account (the `profit_table` call) into the journal.
// It covers everything on the account: the AI Trader, Bulk Trader, the bot builder and manual trades.
import { DerivClientConnection } from '../bulk-trader/derivClient';
import { getActiveToken } from '../bulk-trader/tokenStorage';
import { activeAccount, fromProfitTableRow } from './derivMapping';
import { journalStore } from './journalStore';

const PAGE_SIZE = 100;
/** A sync reads at most this many contracts, newest first, so one click can never run away. */
export const MAX_SYNC = 2000;

export type TSyncResult = { fetched: number; added: number; stopped_early: boolean };

/**
 * Reads the account's history newest-first and stops as soon as a whole page is already in the journal, so a
 * repeat sync only fetches what is new. `onProgress` receives the number of contracts fetched so far.
 */
export const syncFromDeriv = async (onProgress?: (fetched: number) => void): Promise<TSyncResult> => {
    const token = getActiveToken();
    if (!token) throw new Error('No active login found. Log in with your Deriv account first.');
    const connection = new DerivClientConnection(token);
    try {
        const auth = await connection.connect();
        const account = auth.authorize.loginid || activeAccount();
        const known = new Set(journalStore.trades(account).map(t => t.id));

        let fetched = 0;
        let added = 0;
        let stopped_early = false;
        for (let offset = 0; offset < MAX_SYNC; offset += PAGE_SIZE) {
            const res = await connection.send({ profit_table: 1, description: 1, limit: PAGE_SIZE, offset, sort: 'DESC' });
            const rows: Record<string, unknown>[] = res?.profit_table?.transactions ?? [];
            if (!rows.length) break;
            const trades = rows.map(r => fromProfitTableRow(r, account)).filter(t => t !== null);
            fetched += rows.length;
            const fresh = trades.filter(t => !known.has(t!.id));
            added += journalStore.addMany(trades as never);
            onProgress?.(fetched);
            if (fresh.length === 0) {
                stopped_early = true; // this whole page was already in the journal
                break;
            }
            if (rows.length < PAGE_SIZE) break;
        }
        journalStore.flush();
        return { fetched, added, stopped_early };
    } finally {
        connection.close();
    }
};
