// The journal's storage: every settled trade, per Deriv account, kept in this browser.
//
// - Deduplicated by Deriv contract id, so recording a trade twice (live, then again from a Deriv sync) is safe.
// - The AI auto-trader records its own trades with full context (strategy, stake step, confidence), which later
//   lets it review its decisions. Trades from other places are filled in from your Deriv account history.
// - History is not lost if this browser's storage is cleared: "Sync from Deriv" in the Journal tab rebuilds it
//   from your account (without the AI's context).
import { activeAccount } from './derivMapping';
import { buildSelfReview, TReviewGate, TSelfReview } from './selfReview';
import type { TJournalAiContext, TJournalSource, TJournalTrade } from './types';

const KEY_PREFIX = 'digitx.journal.v1.';
const SELF_REVIEW_FLAG = 'digitx.journal.selfreview'; // 'off' disables the AI's use of its self-review
/** Per account. ~200 bytes each, so this stays well inside the browser's storage quota. */
export const MAX_TRADES = 5000;
const SAVE_DELAY_MS = 800;

const RANK: Record<TJournalSource, number> = { ai: 3, bulk: 2, deriv: 1 };

/** Combines a stored trade with a newer sighting of the same contract: keeps the richest information. */
export const mergeTrade = (a: TJournalTrade | undefined, b: TJournalTrade): TJournalTrade => {
    if (!a) return b;
    const source = RANK[a.source] >= RANK[b.source] ? a.source : b.source;
    return {
        ...a,
        symbol: a.symbol === 'unknown' ? b.symbol : a.symbol,
        type: a.type === 'unknown' ? b.type : a.type,
        ticks: a.ticks ?? b.ticks,
        ai: a.ai ?? b.ai,
        source,
    };
};

const storage = (): Storage | null => {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
        return null;
    }
};

type TAccountData = { map: Map<string, TJournalTrade>; sorted: TJournalTrade[] | null };

const accounts = new Map<string, TAccountData>();
const listeners = new Set<() => void>();
let version = 0;
let review_cache: { account: string; version: number; review: TSelfReview } | null = null;
const save_timers = new Map<string, ReturnType<typeof setTimeout>>();

const load = (account: string): TAccountData => {
    const cached = accounts.get(account);
    if (cached) return cached;
    const map = new Map<string, TJournalTrade>();
    try {
        const raw = storage()?.getItem(KEY_PREFIX + account);
        if (raw) for (const t of JSON.parse(raw) as TJournalTrade[]) if (t && t.id) map.set(t.id, t);
    } catch {
        /* a corrupt entry is dropped: Sync from Deriv rebuilds it */
    }
    const data = { map, sorted: null };
    accounts.set(account, data);
    return data;
};

const saveNow = (account: string) => {
    const timer = save_timers.get(account);
    if (timer) clearTimeout(timer);
    save_timers.delete(account);
    const data = accounts.get(account);
    if (!data) return;
    try {
        storage()?.setItem(KEY_PREFIX + account, JSON.stringify(sortedOf(data)));
    } catch {
        /* storage full or unavailable: the journal keeps working in memory for this session */
    }
};

const scheduleSave = (account: string) => {
    if (save_timers.has(account)) return;
    save_timers.set(account, setTimeout(() => saveNow(account), SAVE_DELAY_MS));
};

const sortedOf = (data: TAccountData): TJournalTrade[] => {
    if (!data.sorted) data.sorted = [...data.map.values()].sort((a, b) => a.sell_ts - b.sell_ts || a.id.localeCompare(b.id));
    return data.sorted;
};

const touched = (account: string) => {
    const data = load(account);
    data.sorted = null;
    if (data.map.size > MAX_TRADES) {
        const keep = sortedOf(data).slice(-MAX_TRADES);
        data.map = new Map(keep.map(t => [t.id, t]));
        data.sorted = null;
    }
    version += 1;
    scheduleSave(account);
    listeners.forEach(l => l());
};

if (typeof window !== 'undefined') {
    // Never lose the last second of trades when the tab is closed.
    window.addEventListener('pagehide', () => [...save_timers.keys()].forEach(saveNow));
}

export const journalStore = {
    /** Every stored trade for the account, oldest first. */
    trades(account: string = activeAccount()): TJournalTrade[] {
        return sortedOf(load(account));
    },

    /** Adds trades, merging with ones already stored. Returns how many were new. */
    addMany(trades: TJournalTrade[]): number {
        const touched_accounts = new Set<string>();
        let added = 0;
        for (const t of trades) {
            const data = load(t.account);
            const existing = data.map.get(t.id);
            if (!existing) added += 1;
            data.map.set(t.id, mergeTrade(existing, t));
            touched_accounts.add(t.account);
        }
        touched_accounts.forEach(touched);
        return added;
    },

    add(trade: TJournalTrade | null): void {
        if (trade) this.addMany([trade]);
    },

    /** Attaches the AI's decision context to a trade (creating the trade if only the AI knows about it). */
    addAi(trade: TJournalTrade, context: TJournalAiContext): void {
        this.addMany([{ ...trade, source: 'ai', ai: context }]);
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version: () => version,

    /** Writes pending changes to storage right now. */
    flush(): void {
        [...save_timers.keys()].forEach(saveNow);
    },

    // ---- The AI's self-review ------------------------------------------------------------------------------

    /** The AI's review of its own trades on this account (cached until a trade is added). */
    review(account: string = activeAccount()): TSelfReview {
        if (review_cache && review_cache.account === account && review_cache.version === version) return review_cache.review;
        const review = buildSelfReview(this.trades(account), account);
        review_cache = { account, version, review };
        return review;
    },

    /** Whether the AI may use its self-review to skip proven losers. On by default; the user can switch it off. */
    selfReviewEnabled(): boolean {
        return storage()?.getItem(SELF_REVIEW_FLAG) !== 'off';
    },
    setSelfReviewEnabled(on: boolean): void {
        try {
            storage()?.setItem(SELF_REVIEW_FLAG, on ? 'on' : 'off');
        } catch {
            /* ignore */
        }
        listeners.forEach(l => l());
    },

    /** What the AI engine consults before choosing a contract: undefined when the user turned it off. */
    gate(account: string = activeAccount()): TReviewGate | undefined {
        return this.selfReviewEnabled() ? this.review(account).gate : undefined;
    },

    /** Test helper: forget everything held in memory (stored data is untouched). */
    _resetMemory(): void {
        accounts.clear();
        review_cache = null;
        version += 1;
    },
};
