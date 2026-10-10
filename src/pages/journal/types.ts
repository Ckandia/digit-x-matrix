// The journal's own trade record: one settled Deriv contract.

/** Where a trade came from. 'ai' = the AI auto-trader (full context), 'bulk' = the Bulk Trader tab,
 *  'deriv' = pulled from your Deriv account history (bot builder, manual trades, anything else). */
export type TJournalSource = 'ai' | 'bulk' | 'deriv';

/** What the AI knew and chose when it placed the trade, so it can review its own decisions later. */
export type TJournalAiContext = {
    /** Named playbook strategy behind the signal, e.g. 'streak_reversal'. */
    strategy?: string;
    /** Position on the stake ladder: 1 = base stake, 2+ = a growing win streak (reverse mode) or a recovery step. */
    step: number;
    /** The base stake of the session, to compare against what was actually staked. */
    base_stake: number;
    /** Stake method: 'reverse' | 'martingale' | 'flip' | 'flat'. */
    mode: string;
    /** The signal's confidence score (0-100) when the trade was placed. */
    confidence: number;
    /** 'switched' (after 2 losses), 'flipped', or 'streak'. */
    tag?: string;
};

export type TJournalTrade = {
    /** Deriv contract id: the dedupe key. */
    id: string;
    /** Login id of the account the trade was made on, e.g. CR123456. */
    account: string;
    /** Market, e.g. R_100. */
    symbol: string;
    /** Deriv contract type, e.g. DIGITEVEN, CALL, ONETOUCH. */
    type: string;
    stake: number;
    /** What came back: stake + profit (0 on a lost contract). */
    payout: number;
    profit: number;
    /** Epoch milliseconds. */
    buy_ts: number;
    sell_ts: number;
    ticks?: number;
    source: TJournalSource;
    ai?: TJournalAiContext;
};
