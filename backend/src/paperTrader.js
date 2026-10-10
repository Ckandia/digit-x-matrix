// The backend's always-on PAPER trader (the offline "virtual hook").
//
// It never holds a token and never buys anything. For every symbol it follows the live tick feed and,
// for every contract the AI Trader can place, keeps ONE virtual trade open at a time: it opens one,
// settles it exactly like Deriv would (1-tick contracts on the tick after entry; Touch / No Touch over 5
// ticks with a +0.5 barrier), records win / loss, and opens the next. That runs 24/7, whether or not
// anybody has the app open, and the AI Trader reads the results to see which contract, on which market,
// under which conditions, has actually beaten the payout.
//
// What is stored: AGGREGATES only (counts of trades and wins per symbol / contract / condition, and per
// hour). No ticks, quotes or digits are kept, which is what Deriv's 24-hour cache rule is about
// (see db.js signal_history). Counts survive a restart in Postgres when DATABASE_URL is set; otherwise
// they live in memory.
//
// Conditions ("ctx") recorded for every paper trade, so the AI can see when a contract works:
//   all                      every trade
//   sig:none|weak|mid|strong  was it a live signal, and how confident (<30, 30-59, 60+)
//   top:yes|no               was it the #1 ranked signal at that moment
//   prev:win|loss|none       the result of the previous paper trade of the same contract on that market
//                            (this is the virtual-hook question: does a win after a loss come more often?)
//   trend:bull|bear|flat     Rise/Fall only: higher-high / lower-low on the 1-tick chart
import { getPool } from './db.js';

export const PAPER_CONTRACTS = [
    { type: 'DIGITEVEN', ticks: 1 },
    { type: 'DIGITODD', ticks: 1 },
    { type: 'DIGITOVER', ticks: 1 }, // Over 4
    { type: 'DIGITUNDER', ticks: 1 }, // Under 5
    { type: 'CALL', ticks: 1 },
    { type: 'PUT', ticks: 1 },
    { type: 'ONETOUCH', ticks: 5 }, // barrier +0.5
    { type: 'NOTOUCH', ticks: 5 },
];

const TOUCH_BARRIER = 0.5;
const FLUSH_MS = 60_000;
const HOURLY_KEEP_HOURS = 24 * 7;
const RECENT_HOURS = 24;
const DEFAULT_PAYOUT_RATIO = 0.82; // what a win paid in the owner's trade history (0.78-0.85 of the stake)

/** Settles a paper trade the way Deriv would. `after` = ticks following the entry tick. true/false/null (not yet). */
export const paperOutcome = (type, entry, after, pip, needed = 1) => {
    if (type === 'ONETOUCH' || type === 'NOTOUCH') {
        const touched = after.slice(0, needed).some(q => q >= entry + TOUCH_BARRIER);
        if (touched) return type === 'ONETOUCH';
        return after.length >= needed ? type === 'NOTOUCH' : null;
    }
    if (after.length < 1) return null;
    const exit = after[0];
    const digit = Number(Number(exit).toFixed(pip).slice(-1));
    switch (type) {
        case 'DIGITEVEN':
            return digit % 2 === 0;
        case 'DIGITODD':
            return digit % 2 === 1;
        case 'DIGITOVER':
            return digit > 4;
        case 'DIGITUNDER':
            return digit < 5;
        case 'CALL':
            return exit > entry;
        case 'PUT':
            return exit < entry;
        default:
            return null;
    }
};

// Same rule as the app's 1-tick trend gate (src/pages/bulk-trader/trendFilter.ts).
const findSwings = (prices, k = 2) => {
    const highs = [];
    const lows = [];
    for (let i = k; i < prices.length - k; i++) {
        let is_high = true;
        let is_low = true;
        for (let j = 1; j <= k; j++) {
            if (!(prices[i] > prices[i - j]) || !(prices[i] >= prices[i + j])) is_high = false;
            if (!(prices[i] < prices[i - j]) || !(prices[i] <= prices[i + j])) is_low = false;
        }
        if (is_high) highs.push(prices[i]);
        if (is_low) lows.push(prices[i]);
    }
    return { highs, lows };
};
export const detectTrend = prices => {
    const { highs, lows } = findSwings(prices);
    const hh = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
    const ll = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];
    if (hh && !ll) return 'bull';
    if (ll && !hh) return 'bear';
    return 'flat';
};

/** Lower end of the 95% Wilson interval for a win rate: how low the true rate could plausibly be. */
export const wilsonLow = (n, wins) => {
    if (!n) return 0;
    const z = 1.96;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return Math.max(0, (centre - margin) / denom);
};

const bucketOf = confidence => (confidence >= 60 ? 'strong' : confidence >= 30 ? 'mid' : 'weak');
const hourKey = ms => new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();

export class PaperTrader {
    constructor(marketFeed) {
        this.feed = marketFeed;
        this.cells = new Map(); // `${symbol}|${type}|${ctx}` -> { n, wins }   (cumulative, survives restarts via the DB)
        this.deltas = new Map(); // same keys: not yet written to the DB
        this.hourly = new Map(); // `${hourISO}|${symbol}|${type}` -> { n, wins }
        this.hourly_deltas = new Map();
        this.open = new Map(); // `${symbol}|${type}` -> open paper trade
        this.last = new Map(); // `${symbol}|${type}` -> 'win' | 'loss'
        this.started_at = new Date().toISOString();
        this.total = 0;
        this.timer = null;
        this.table_ready = false;
    }

    async start() {
        await this._load();
        this.feed.onTick((symbol, tick, snapshot) => this._onTick(symbol, tick, snapshot));
        this.timer = setInterval(() => this._flush().catch(err => console.error('[paper] flush failed:', err.message)), FLUSH_MS);
        this.timer.unref?.();
        console.log('[paper] paper trader running: virtual trades on every market, 24/7, no token, no money.');
    }

    async _ensureTables(pool) {
        if (this.table_ready) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS paper_stats (
                symbol TEXT NOT NULL, contract_type TEXT NOT NULL, ctx TEXT NOT NULL,
                n BIGINT NOT NULL DEFAULT 0, wins BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (symbol, contract_type, ctx)
            );`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS paper_hourly (
                hour TIMESTAMPTZ NOT NULL, symbol TEXT NOT NULL, contract_type TEXT NOT NULL,
                n INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (hour, symbol, contract_type)
            );`);
        this.table_ready = true;
    }

    async _load() {
        const pool = getPool();
        if (!pool) return;
        try {
            await this._ensureTables(pool);
            const stats = await pool.query('SELECT symbol, contract_type, ctx, n::float8 AS n, wins::float8 AS wins FROM paper_stats');
            for (const r of stats.rows) {
                this.cells.set(`${r.symbol}|${r.contract_type}|${r.ctx}`, { n: r.n, wins: r.wins });
                if (r.ctx === 'all') this.total += r.n;
            }
            const hours = await pool.query(
                `SELECT hour, symbol, contract_type, n, wins FROM paper_hourly WHERE hour > now() - ($1 || ' hours')::interval`,
                [String(HOURLY_KEEP_HOURS)]
            );
            for (const r of hours.rows) this.hourly.set(`${new Date(r.hour).toISOString()}|${r.symbol}|${r.contract_type}`, { n: r.n, wins: r.wins });
            console.log(`[paper] restored ${stats.rows.length} stat cells and ${hours.rows.length} hourly buckets from Postgres.`);
        } catch (err) {
            console.error('[paper] could not restore from Postgres, starting fresh:', err.message);
        }
    }

    _bump(map, key, win) {
        const c = map.get(key) || { n: 0, wins: 0 };
        c.n += 1;
        if (win) c.wins += 1;
        map.set(key, c);
    }

    _record(symbol, type, ctxs, win) {
        for (const ctx of ctxs) {
            const key = `${symbol}|${type}|${ctx}`;
            this._bump(this.cells, key, win);
            this._bump(this.deltas, key, win);
        }
        const hk = `${hourKey(Date.now())}|${symbol}|${type}`;
        this._bump(this.hourly, hk, win);
        this._bump(this.hourly_deltas, hk, win);
        this.last.set(`${symbol}|${type}`, win ? 'win' : 'loss');
        this.total += 1;
    }

    _contextFor(symbol, type, snapshot) {
        const signals = snapshot?.signals ?? [];
        const sig = signals.find(s => s.contract_type === type);
        const ctxs = ['all', sig ? `sig:${bucketOf(sig.confidence)}` : 'sig:none', `top:${signals[0]?.contract_type === type ? 'yes' : 'no'}`];
        ctxs.push(`prev:${this.last.get(`${symbol}|${type}`) ?? 'none'}`);
        if (type === 'CALL' || type === 'PUT') {
            const prices = this.feed.priceWindows.get(symbol)?.prices ?? [];
            ctxs.push(`trend:${detectTrend(prices.slice(-60))}`);
        }
        return ctxs;
    }

    _onTick(symbol, tick, snapshot) {
        const pip = Number.isInteger(tick.pip_size) ? tick.pip_size : this.feed.getPipSize(symbol);
        for (const { type, ticks } of PAPER_CONTRACTS) {
            const key = `${symbol}|${type}`;
            const pos = this.open.get(key);
            if (pos) {
                if (pos.phase === 'entry') {
                    pos.entry = tick.quote; // the first tick after the virtual buy, like a real purchase
                    pos.phase = 'running';
                    continue;
                }
                pos.after.push(tick.quote);
                const result = paperOutcome(type, pos.entry, pos.after, pip, ticks);
                if (result === null) continue;
                this._record(symbol, type, pos.ctxs, result);
                this.open.delete(key);
            }
            // Next paper trade: decided now, enters on the next tick.
            this.open.set(key, { phase: 'entry', entry: 0, after: [], ctxs: this._contextFor(symbol, type, snapshot) });
        }
    }

    async _flush() {
        const pool = getPool();
        if (!pool || (this.deltas.size === 0 && this.hourly_deltas.size === 0)) return;
        await this._ensureTables(pool);
        const deltas = this.deltas;
        const hourly = this.hourly_deltas;
        this.deltas = new Map();
        this.hourly_deltas = new Map();
        try {
            for (const [key, c] of deltas) {
                const [symbol, type, ctx] = key.split('|');
                await pool.query(
                    `INSERT INTO paper_stats (symbol, contract_type, ctx, n, wins) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (symbol, contract_type, ctx) DO UPDATE SET n = paper_stats.n + EXCLUDED.n,
                        wins = paper_stats.wins + EXCLUDED.wins, updated_at = now()`,
                    [symbol, type, ctx, c.n, c.wins]
                );
            }
            for (const [key, c] of hourly) {
                const [hour, symbol, type] = key.split('|');
                await pool.query(
                    `INSERT INTO paper_hourly (hour, symbol, contract_type, n, wins) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (hour, symbol, contract_type) DO UPDATE SET n = paper_hourly.n + EXCLUDED.n, wins = paper_hourly.wins + EXCLUDED.wins`,
                    [hour, symbol, type, c.n, c.wins]
                );
            }
            await pool.query(`DELETE FROM paper_hourly WHERE hour < now() - ($1 || ' hours')::interval`, [String(HOURLY_KEEP_HOURS)]);
        } catch (err) {
            // Put the counts back so the next flush retries them.
            for (const [k, c] of deltas) {
                const d = this.deltas.get(k) || { n: 0, wins: 0 };
                this.deltas.set(k, { n: d.n + c.n, wins: d.wins + c.wins });
            }
            for (const [k, c] of hourly) {
                const d = this.hourly_deltas.get(k) || { n: 0, wins: 0 };
                this.hourly_deltas.set(k, { n: d.n + c.n, wins: d.wins + c.wins });
            }
            throw err;
        }
    }

    /** Everything the AI Trader (and the owner) needs to judge each contract on each market. */
    getReport() {
        const recent_cut = Date.now() - RECENT_HOURS * 3_600_000;
        const recent = new Map();
        for (const [key, c] of this.hourly) {
            const [hour, symbol, type] = key.split('|');
            if (new Date(hour).getTime() < recent_cut) continue;
            const k = `${symbol}|${type}`;
            const r = recent.get(k) || { n: 0, wins: 0 };
            r.n += c.n;
            r.wins += c.wins;
            recent.set(k, r);
        }
        const by_cell = new Map();
        const hook = { after_loss: { n: 0, wins: 0 }, after_win: { n: 0, wins: 0 } };
        for (const [key, c] of this.cells) {
            const [symbol, type, ctx] = key.split('|');
            const k = `${symbol}|${type}`;
            const cell = by_cell.get(k) || { symbol, contract_type: type, n: 0, wins: 0, ctx: {} };
            if (ctx === 'all') {
                cell.n = c.n;
                cell.wins = c.wins;
            } else {
                cell.ctx[ctx] = { n: c.n, wins: c.wins, win_rate: c.n ? c.wins / c.n : 0, low: wilsonLow(c.n, c.wins) };
                if (ctx === 'prev:loss') {
                    hook.after_loss.n += c.n;
                    hook.after_loss.wins += c.wins;
                } else if (ctx === 'prev:win') {
                    hook.after_win.n += c.n;
                    hook.after_win.wins += c.wins;
                }
            }
            by_cell.set(k, cell);
        }
        const cells = [...by_cell.values()].map(cell => {
            const r = recent.get(`${cell.symbol}|${cell.contract_type}`) || { n: 0, wins: 0 };
            return {
                ...cell,
                win_rate: cell.n ? cell.wins / cell.n : 0,
                low: wilsonLow(cell.n, cell.wins),
                recent_n: r.n,
                recent_win_rate: r.n ? r.wins / r.n : 0,
            };
        });
        const rate = h => (h.n ? h.wins / h.n : 0);
        return {
            started_at: this.started_at,
            total_paper_trades: this.total,
            breakeven_win_rate: Number((1 / (1 + DEFAULT_PAYOUT_RATIO)).toFixed(4)),
            payout_ratio_assumed: DEFAULT_PAYOUT_RATIO,
            hook: { after_loss: { ...hook.after_loss, win_rate: rate(hook.after_loss) }, after_win: { ...hook.after_win, win_rate: rate(hook.after_win) } },
            cells,
        };
    }
}
