// Trend confirmation on the 1-tick chart (every tick is one candle).
//
//   Bullish = the last two swing HIGHS are rising (a higher high).
//   Bearish = the last two swing LOWS are falling (a lower low).
//   If both are true (the range is widening both ways) the market is not trending: no trade.
//
// A swing high is a tick higher than the `k` ticks before it and at least as high as the `k` ticks
// after it (swing low: the mirror image). So a swing point is only confirmed `k` ticks after it forms.
import type { DerivClientConnection } from './derivClient';
import type { TTrendSide } from './contractSpecs';

export type TTrend = TTrendSide | 'none';

export const SWING_K = 2;
export const TREND_WINDOW = 60;

export const findSwings = (prices: number[], k = SWING_K): { highs: number[]; lows: number[] } => {
    const highs: number[] = [];
    const lows: number[] = [];
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

export const detectTrend = (prices: number[], k = SWING_K): TTrend => {
    const { highs, lows } = findSwings(prices, k);
    const higher_high = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
    const lower_low = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];
    if (higher_high && !lower_low) return 'bullish';
    if (lower_low && !higher_high) return 'bearish';
    return 'none';
};

export const trendLabel = (side: TTrendSide) => (side === 'bullish' ? 'higher-high trend' : 'lower-low trend');

/** Keeps the latest ticks of one market and tells callers when a trend is confirmed. */
export class TickTrendMonitor {
    prices: number[] = [];
    private last_epoch = 0;
    private sub: number | null = null;
    private stopped = false;
    private waiters = new Set<() => void>();

    constructor(private connection: DerivClientConnection, private symbol: string) {}

    /** Seeds from recent history (best effort), then follows live ticks. */
    async start() {
        try {
            const res = await this.connection.send({
                ticks_history: this.symbol,
                count: TREND_WINDOW,
                end: 'latest',
                style: 'ticks',
            });
            const prices: unknown[] = res?.history?.prices ?? [];
            const times: unknown[] = res?.history?.times ?? [];
            prices.forEach((p, i) => this._push(Number(p), Number(times[i] ?? 0)));
        } catch {
            /* no history: the monitor fills up from live ticks */
        }
        if (this.stopped) return;
        this.sub = this.connection.subscribe({ ticks: this.symbol }, data => {
            const tick = data?.tick;
            if (tick) this._push(Number(tick.quote), Number(tick.epoch ?? 0));
        });
    }

    private _push(price: number, epoch: number) {
        if (!Number.isFinite(price)) return;
        if (epoch && epoch <= this.last_epoch) return; // already have this tick (history/live overlap)
        if (epoch) this.last_epoch = epoch;
        this.prices.push(price);
        if (this.prices.length > TREND_WINDOW) this.prices.shift();
        this.waiters.forEach(w => w());
    }

    trend(): TTrend {
        return detectTrend(this.prices);
    }

    /** Resolves true once `side` is confirmed, or false if the monitor is stopped first. */
    waitFor(side: TTrendSide): Promise<boolean> {
        return new Promise(resolve => {
            if (this.stopped) return resolve(false);
            const check = () => {
                if (this.stopped) {
                    this.waiters.delete(check);
                    resolve(false);
                } else if (this.trend() === side) {
                    this.waiters.delete(check);
                    resolve(true);
                }
            };
            this.waiters.add(check);
            check();
        });
    }

    stop() {
        this.stopped = true;
        if (this.sub != null) {
            void this.connection.unsubscribe(this.sub);
            this.sub = null;
        }
        this.waiters.forEach(w => w());
        this.waiters.clear();
    }
}
