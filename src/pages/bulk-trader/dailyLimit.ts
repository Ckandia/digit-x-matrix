// A loss limit that spans RUNS. The per-run stop-loss ends one run, but nothing stopped a person (or a habit) from pressing
// Start again and again: every restart got a fresh allowance. This keeps today's net result per account in the browser and
// turns it into what the next run is still allowed to lose. The day is the UTC day (it resets at 00:00 UTC).
const KEY = 'dxm_ai_day_v1';

type TDay = { day: string; start_balance: number; realized: number };

const today = () => new Date().toISOString().slice(0, 10);

const load = (account: string): TDay | null => {
    try {
        const d = JSON.parse(localStorage.getItem(`${KEY}:${account}`) || 'null') as TDay | null;
        return d && d.day === today() ? d : null;
    } catch {
        return null;
    }
};

const save = (account: string, d: TDay) => {
    try {
        localStorage.setItem(`${KEY}:${account}`, JSON.stringify(d));
    } catch {
        /* storage blocked or full: the per-run stop-loss still applies */
    }
};

export type TDailyAllowance = {
    limit: number; // the most today may lose, in currency
    used: number; // how much of it today's net loss has used
    remaining: number; // what the next run may still lose (never negative)
    start_balance: number;
};

/**
 * `pct` of the day's starting balance is the daily loss limit (0 or less = off, returns null).
 * Profits made earlier today do NOT raise the limit: it protects capital, it does not let winnings be risked on top.
 */
export const dailyAllowance = (account: string, balance: number, pct: number): TDailyAllowance | null => {
    if (!(pct > 0) || !account) return null;
    let d = load(account);
    if (!d) {
        d = { day: today(), start_balance: balance, realized: 0 };
        save(account, d);
    }
    const limit = Number(((d.start_balance * pct) / 100).toFixed(2));
    const used = Math.max(0, -d.realized);
    return { limit, used: Number(used.toFixed(2)), remaining: Number(Math.max(0, limit - used).toFixed(2)), start_balance: d.start_balance };
};

/** Adds one settled real trade (profit or loss) to today's total. */
export const recordDayResult = (account: string, balance: number, profit: number) => {
    if (!account || !Number.isFinite(profit)) return;
    const d = load(account) ?? { day: today(), start_balance: balance, realized: 0 };
    d.realized = Number((d.realized + profit).toFixed(2));
    save(account, d);
};
