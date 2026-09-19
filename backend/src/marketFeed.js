import WebSocket from 'ws';
import { computeSignals, computeStats, createDigitWindow, pushDigit } from './digitAnalysis.js';

// Deriv migrated its trading API to this gateway; the old ws.derivws.com/websockets/v3
// endpoint still accepts connections but no longer serves synthetic-index data through
// it. Public market data needs no app_id or auth at all on the new gateway.
const DERIV_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const HISTORY_COUNT = 500; // ticks_history backfill so the window isn't empty on boot
const RECONNECT_DELAY_MS = 3000;

export const DIGIT_SYMBOLS = [
    { symbol: 'R_10', display_name: 'Volatility 10 Index' },
    { symbol: 'R_25', display_name: 'Volatility 25 Index' },
    { symbol: 'R_50', display_name: 'Volatility 50 Index' },
    { symbol: 'R_75', display_name: 'Volatility 75 Index' },
    { symbol: 'R_100', display_name: 'Volatility 100 Index' },
    { symbol: '1HZ10V', display_name: 'Volatility 10 (1s) Index' },
    { symbol: '1HZ25V', display_name: 'Volatility 25 (1s) Index' },
    { symbol: '1HZ50V', display_name: 'Volatility 50 (1s) Index' },
    { symbol: '1HZ75V', display_name: 'Volatility 75 (1s) Index' },
    { symbol: '1HZ100V', display_name: 'Volatility 100 (1s) Index' },
];

const lastDigitOf = quote => {
    // Deriv quotes are decimal strings/numbers with a fixed pip size per symbol;
    // the "last digit" is the last digit of the quote as displayed, i.e. after
    // rounding to the symbol's pip size. `data.tick.quote` already comes rounded
    // to that precision, so we can read the string form directly.
    const str = String(quote);
    const digits_only = str.replace('.', '');
    return Number(digits_only[digits_only.length - 1]);
};

/**
 * MarketFeed owns ONE public (unauthenticated) WebSocket to Deriv, subscribed to
 * ticks for every symbol in DIGIT_SYMBOLS, and keeps a rolling digit window per
 * symbol. No account token is ever involved — this is market data only, the
 * "brain" that computes stats/signals for the Digit Matrix tab. Auto-reconnects
 * on drop. Call `onUpdate(symbol, stats, signals)` to receive live pushes.
 */
export class MarketFeed {
    constructor() {
        this.ws = null;
        this.windows = new Map(); // symbol -> digit window
        this.req_id_counter = 1;
        this.pending = new Map();
        this.listeners = new Set();
        this._reconnectTimer = null;
        for (const { symbol } of DIGIT_SYMBOLS) this.windows.set(symbol, createDigitWindow());
    }

    onUpdate(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    start() {
        this._connect();
    }

    stop() {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        try {
            this.ws?.close();
        } catch {
            // ignore
        }
    }

    /** Current snapshot (stats + signals) for every tracked symbol. */
    getAllSnapshots() {
        const out = {};
        for (const { symbol } of DIGIT_SYMBOLS) {
            const stats = computeStats(this.windows.get(symbol), symbol);
            out[symbol] = { stats, signals: computeSignals(stats) };
        }
        return out;
    }

    getSnapshot(symbol) {
        const window = this.windows.get(symbol);
        if (!window) return null;
        const stats = computeStats(window, symbol);
        return { stats, signals: computeSignals(stats) };
    }

    _nextReqId() {
        return this.req_id_counter++;
    }

    _connect() {
        this.ws = new WebSocket(DERIV_WS_URL);

        this.ws.on('open', () => {
            // eslint-disable-next-line no-console
            console.log('[marketFeed] connected to Deriv, backfilling + subscribing…');
            for (const { symbol } of DIGIT_SYMBOLS) {
                this._backfillAndSubscribe(symbol);
            }
        });

        this.ws.on('message', raw => this._handleMessage(raw));

        this.ws.on('error', err => {
            // eslint-disable-next-line no-console
            console.error('[marketFeed] socket error:', err.message);
        });

        this.ws.on('close', () => {
            // eslint-disable-next-line no-console
            console.warn('[marketFeed] connection closed, reconnecting in', RECONNECT_DELAY_MS, 'ms');
            this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
        });
    }

    _send(request) {
        const req_id = this._nextReqId();
        this.ws.send(JSON.stringify({ ...request, req_id }));
        return req_id;
    }

    _backfillAndSubscribe(symbol) {
        // One request pulls recent history AND opens the live subscription
        // (subscribe: 1 on ticks_history streams ticks going forward too).
        this._send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: HISTORY_COUNT,
            end: 'latest',
            style: 'ticks',
            subscribe: 1,
        });
    }

    _handleMessage(raw) {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (data.error) {
            // eslint-disable-next-line no-console
            console.error('[marketFeed] Deriv error:', data.error.message);
            return;
        }

        if (data.msg_type === 'history' && data.echo_req?.ticks_history) {
            const symbol = data.echo_req.ticks_history;
            const window = createDigitWindow();
            const prices = data.history?.prices ?? [];
            for (const price of prices) pushDigit(window, lastDigitOf(price));
            this.windows.set(symbol, window);
            this._emit(symbol);
            return;
        }

        if (data.msg_type === 'tick' && data.tick) {
            const { symbol, quote } = data.tick;
            const window = this.windows.get(symbol);
            if (!window) return;
            pushDigit(window, lastDigitOf(quote));
            this._emit(symbol);
        }
    }

    _emit(symbol) {
        const snapshot = this.getSnapshot(symbol);
        if (!snapshot) return;
        for (const fn of this.listeners) fn(symbol, snapshot.stats, snapshot.signals);
    }
}
