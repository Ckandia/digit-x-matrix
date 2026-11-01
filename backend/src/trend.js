// Trend confirmation on the 1-tick chart (every tick is one candle). Same rule as the frontend's trendFilter.ts, so the backend
// can confirm the trend BEFORE it flags an entry and the AI can buy the next tick without asking for the chart again.
//
//   Bullish = the last two swing HIGHS are rising (a higher high).
//   Bearish = the last two swing LOWS are falling (a lower low).
//   If both are true (the range is widening both ways) the market is not trending: 'none'.
export const SWING_K = 2;
export const TREND_WINDOW = 60;

export function findSwings(prices, k = SWING_K) {
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
}

export function detectTrend(prices, k = SWING_K) {
    const { highs, lows } = findSwings(prices, k);
    const higher_high = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
    const lower_low = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];
    if (higher_high && !lower_low) return 'bullish';
    if (lower_low && !higher_high) return 'bearish';
    return 'none';
}
