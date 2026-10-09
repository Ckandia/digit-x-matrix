import WebSocket from 'ws';
import { computeSignals, computeStats, createDigitWindow, pushDigit } from './digitAnalysis.js';
import { computeContractSignals, createPriceWindow, pushPrice } from './contractAnalysis.js';
import { computeStreakSignal } from './streakStrategy.js';

// Deriv's current documentation ("Use ONLY this API") and live testing both
// confirm ws.derivws.com/websockets/v3 (legacy v3) is now unreliable —
// connections there are dropping with HTTP 520s. The New Options API's public
// gateway serves the same active_symbols / ticks_history / tick messages this
// file needs, unauthenticated, no app_id required:
//   wss://api.derivws.com/trading/v1/options/ws/public
// It renames a few response fields (active_symbols: symbol -> underlying_symbol;
// see the entry.symbol/entry.underlying_symbol fallback below) but the tick and
// ticks_history/history messages this file relies on are unchanged.
//
// The legacy endpoint is kept as a second candidate only as a safety net if the
// new gateway ever has its own outage — endpoints are tried in order and the
// first one that delivers a valid response wins, so a bad guess degrades to a
// retry instead of a silent dead feed.
const WS_APP_ID = (process.env.DERIV_WS_APP_ID || '1089').trim();
const DERIV_WS_ENDPOINTS = (
    process.env.DERIV_WS_URL
        ? [process.env.DERIV_WS_URL.trim()]
        : [
              'wss://api.derivws.com/trading/v1/options/ws/public',
              `wss://ws.derivws.com/websockets/v3?app_id=${WS_APP_ID}`,
          ]
).filter(Boolean);
const HISTORY_COUNT = 500; // ticks_history backfill so the window isn't empty on boot
const RECONNECT_DELAY_MS = 3000;

export const DIGIT_SYMBOLS = [
    { symbol: '1HZ10V', display_name: 'Volatility 10 (1s) Index' },
    { symbol: '1HZ25V', display_name: 'Volatility 25 (1s) Index' },
    { symbol: '1HZ50V', display_name: 'Volatility 50 (1s) Index' },
    { symbol: '1HZ75V', display_name: 'Volatility 75 (1s) Index' },
    { symbol: '1HZ100V', display_name: 'Volatility 100 (1s) Index' },
];

// Fallback pip sizes (decimal places) used only until active_symbols responds.
// Deriv synthetics do NOT share a precision: R_100 prints 2dp, R_10/R_25 3dp,
// R_50/R_75 4dp, and the 1HZ family differs again. Getting this wrong silently
// corrupts the whole digit distribution (see lastDigitOf below).
const FALLBACK_PIP_SIZE = {
    R_10: 3,
    R_25: 3,
    R_50: 4,
    R_75: 4,
    R_100: 2,
    '1HZ10V': 2,
    '1HZ25V': 2,
    '1HZ50V': 2,
    '1HZ75V': 2,
    '1HZ100V': 2,
};

/**
 * Extracts the last displayed digit of a quote.
 *
 * THE BUG THIS FIXES: the old version did `String(quote)`. Deriv sends the quote
 * as a JSON number, so JSON.parse turns "184.5670" into the Number 184.567 and
 * the trailing zero is gone forever. String() then read "7" as the last digit.
 *
 * Consequence: digit 0 could only ever be counted when the quote genuinely ended
 * in a non-zero-padded 0, which for a 4dp symbol is almost never — so digit 0
 * showed ~0% frequency, and every other digit was inflated to absorb its share.
 * The distribution was wrong across the board, not just for 0.
 *
 * The fix is to pad back to the symbol's real pip size before reading the digit.
 */
const lastDigitOf = (quote, pip_size) => {
    const dp = Number.isInteger(pip_size) ? pip_size : 2;
    const fixed = Number(quote).toFixed(dp); // re-pads the lost trailing zeros
    return Number(fixed[fixed.length - 1]);
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
        this.priceWindows = new Map(); // symbol -> raw price window (rise/fall, touch, asians, etc.)
        this.req_id_counter = 1;
        this.pending = new Map();
        this.listeners = new Set();
        this.tickListeners = new Set();
        this._reconnectTimer = null;
        this._endpoint_index = 0;
        this._got_valid_data = false;
        // symbol -> decimal places. Seeded with fallbacks, then overwritten by
        // the authoritative values from active_symbols as soon as they arrive.
        this.pip_sizes = new Map(Object.entries(FALLBACK_PIP_SIZE));
        this._pending_history = new Map(); // symbol -> raw prices awaiting pip size
        for (const { symbol } of DIGIT_SYMBOLS) {
            this.windows.set(symbol, createDigitWindow());
            this.priceWindows.set(symbol, createPriceWindow());
        }
    }

    onUpdate(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** Called for every live tick with (symbol, { quote, pip_size, epoch }, snapshot). Used by the paper trader. */
    onTick(fn) {
        this.tickListeners.add(fn);
        return () => this.tickListeners.delete(fn);
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
            out[symbol] = this.getSnapshot(symbol);
        }
        return out;
    }

    /** Combines digit signals (family: 'digits', incl. the streak-reversal playbook) with the
     *  price-based Rise/Fall and the barrier contracts (Touch/No Touch, Stays Between/Goes Outside,
     *  Ends Between/Outside) into one ranked list. */
    getSnapshot(symbol) {
        const window = this.windows.get(symbol);
        const priceWindow = this.priceWindows.get(symbol);
        if (!window || !priceWindow) return null;
        const stats = computeStats(window, symbol);
        const digit_signals = computeSignals(stats).map(s => ({ family: 'digits', ...s }));
        // The owner's Even/Odd streak-reversal playbook (rare: needs a 5+ run and slowing tick speed).
        const streak_signal = computeStreakSignal(stats, priceWindow);
        if (streak_signal) digit_signals.push(streak_signal);
        const contract_signals = computeContractSignals(priceWindow, symbol, this.getPipSize(symbol));
        const signals = [...digit_signals, ...contract_signals].sort((a, b) => b.confidence - a.confidence);
        return { stats, signals };
    }

    _nextReqId() {
        return this.req_id_counter++;
    }

    /** The endpoint currently being tried. */
    get endpoint() {
        return DERIV_WS_ENDPOINTS[this._endpoint_index % DERIV_WS_ENDPOINTS.length];
    }

    _connect() {
        const url = this.endpoint;
        // eslint-disable-next-line no-console
        console.log('[marketFeed] dialling', url.replace(/app_id=[^&]*/, 'app_id=***'));
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            // eslint-disable-next-line no-console
            console.log('[marketFeed] connected to Deriv, resolving pip sizes…');
            // Ask for real precision FIRST. Digit stats are meaningless without it.
            // product_type is a legacy-only filter param, removed in the New API —
            // dropping it works on both gateways.
            this._send({ active_symbols: 'brief' });
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
            // If this endpoint never produced usable data, rotate to the next
            // candidate rather than retrying a URL that clearly doesn't work.
            if (!this._got_valid_data && DERIV_WS_ENDPOINTS.length > 1) {
                this._endpoint_index += 1;
                // eslint-disable-next-line no-console
                console.warn('[marketFeed] no data from that endpoint — trying the next one');
            }
            // eslint-disable-next-line no-console
            console.warn('[marketFeed] connection closed, reconnecting in', RECONNECT_DELAY_MS, 'ms');
            this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
        });
    }

    /**
     * What Deriv actually offers for a symbol: for every contract type, the tick-duration range
     * (or null when it is not offered in ticks, e.g. only minutes/days). Cached for 6 hours.
     * Resolves to null if Deriv does not answer, so callers can fall back to their own table.
     */
    getContractRules(symbol) {
        const cached = this.contract_rules?.get(symbol);
        if (cached && Date.now() - cached.at < 6 * 3600_000) return Promise.resolve(cached.rules);
        if (!this.ws || this.ws.readyState !== 1) return Promise.resolve(null);
        this.contract_rules ||= new Map();
        this.rules_waiters ||= new Map();
        return new Promise(resolve => {
            const waiters = this.rules_waiters.get(symbol) || [];
            waiters.push(resolve);
            this.rules_waiters.set(symbol, waiters);
            if (waiters.length === 1) {
                this._send({ contracts_for: symbol, currency: 'USD' });
                setTimeout(() => this._resolveRules(symbol, null), 6000);
            }
        });
    }

    _resolveRules(symbol, rules) {
        const waiters = this.rules_waiters?.get(symbol);
        if (!waiters) return;
        this.rules_waiters.delete(symbol);
        if (rules) this.contract_rules.set(symbol, { at: Date.now(), rules });
        for (const resolve of waiters) resolve(rules);
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
            if (data.echo_req?.contracts_for) this._resolveRules(data.echo_req.contracts_for, null);
            return;
        }

        this._got_valid_data = true;

        if (data.msg_type === 'active_symbols' && Array.isArray(data.active_symbols)) {
            for (const entry of data.active_symbols) {
                // The New API renamed this response field symbol -> underlying_symbol;
                // legacy still sends `symbol`. Accept either.
                const entry_symbol = entry.symbol || entry.underlying_symbol;
                // Deriv exposes precision as `pip` (e.g. 0.0001) and/or `pip_size` (e.g. 4).
                let dp = entry.pip_size;
                if (!Number.isInteger(dp) && typeof entry.pip === 'number' && entry.pip > 0) {
                    dp = Math.round(Math.log10(1 / entry.pip));
                }
                if (entry_symbol && Number.isInteger(dp) && dp >= 0 && dp <= 8) {
                    this.pip_sizes.set(entry_symbol, dp);
                }
            }
            // Any history that landed before we knew the precision was parsed with a
            // fallback — rebuild those windows now so they aren't silently skewed.
            for (const [symbol, prices] of this._pending_history) {
                this._rebuildWindow(symbol, prices);
            }
            this._pending_history.clear();
            return;
        }

        if (data.msg_type === 'contracts_for' && data.echo_req?.contracts_for) {
            const list = data.contracts_for?.available || data.contracts_for?.contracts || [];
            const parse = v => {
                const m = /^(\d+)([tsmhd])$/.exec(String(v ?? ''));
                return m ? { value: Number(m[1]), unit: m[2] } : null;
            };
            const rules = {};
            for (const c of list) {
                const type = c.contract_type;
                if (!type) continue;
                const min = parse(c.min_contract_duration);
                const max = parse(c.max_contract_duration);
                if (min?.unit === 't') {
                    const hi = max?.unit === 't' ? max.value : 10;
                    const prev = rules[type];
                    rules[type] = { min: prev ? Math.min(prev.min, min.value) : min.value, max: prev ? Math.max(prev.max, hi) : hi };
                } else if (!(type in rules)) {
                    rules[type] = null; // offered, but not in ticks
                }
            }
            this._resolveRules(data.echo_req.contracts_for, Object.keys(rules).length ? rules : null);
            return;
        }

        if (data.msg_type === 'history' && data.echo_req?.ticks_history) {
            const symbol = data.echo_req.ticks_history;
            const prices = data.history?.prices ?? [];
            // Keep the raw prices so we can re-derive digits if active_symbols
            // later tells us this symbol's precision differs from our fallback.
            this._pending_history.set(symbol, prices);
            this._rebuildWindow(symbol, prices);
            return;
        }

        if (data.msg_type === 'tick' && data.tick) {
            const { symbol, quote, pip_size } = data.tick;
            const window = this.windows.get(symbol);
            const priceWindow = this.priceWindows.get(symbol);
            if (!window || !priceWindow) return;
            // The tick frame is the most authoritative source when present.
            if (Number.isInteger(pip_size)) this.pip_sizes.set(symbol, pip_size);
            pushDigit(window, lastDigitOf(quote, this.pip_sizes.get(symbol)));
            pushPrice(priceWindow, quote);
            this._emit(symbol, { quote: Number(quote), pip_size: this.pip_sizes.get(symbol), epoch: data.tick.epoch });
        }
    }

    /** Decimal places for a symbol, falling back to 2 if we somehow have none. */
    getPipSize(symbol) {
        return this.pip_sizes.get(symbol) ?? 2;
    }



    /** (Re)builds a symbol's rolling digit + price windows from raw history at current precision. */
    _rebuildWindow(symbol, prices) {
        const dp = this.getPipSize(symbol);
        const window = createDigitWindow();
        const priceWindow = createPriceWindow();
        for (const price of prices) {
            pushDigit(window, lastDigitOf(price, dp));
            pushPrice(priceWindow, price);
        }
        this.windows.set(symbol, window);
        this.priceWindows.set(symbol, priceWindow);
        this._emit(symbol);
    }

    _emit(symbol, tick) {
        const snapshot = this.getSnapshot(symbol);
        if (!snapshot) return;
        for (const fn of this.listeners) fn(symbol, snapshot.stats, snapshot.signals);
        if (tick) {
            for (const fn of this.tickListeners) {
                try {
                    fn(symbol, tick, snapshot);
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error('[marketFeed] tick listener failed:', err.message);
                }
            }
        }
    }
}
