import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// This connects using Deriv's CLASSIC protocol (a single `{authorize: token}`
// message over wss://ws.derivws.com/websockets/v3), matching marketFeed.js
// and every message this backend already sends downstream — StrategyEngine.js
// and aiAgent.js both build `buy` requests with a `symbol` field and read
// `proposal_open_contract` responses, which are classic-protocol shapes.
//
// An earlier version of this file used Deriv's newer "Options Trading API"
// (REST + a one-time-password-signed WebSocket URL at
// /trading/v1/options/ws/real|demo). That is a real, currently-documented
// Deriv product — but it is a DIFFERENT product with a different message
// schema (its field is `underlying_symbol`, not `symbol`), and this backend's
// StrategyEngine/aiAgent never spoke that schema. Pointing an OTP-authenticated
// Options connection at classic-shaped buy/subscribe requests meant those
// requests were malformed for the endpoint they were sent to — which is what
// produced the timeouts and rejected promises seen in production. Reverting
// to the classic single-step handshake makes the connection match the
// messages actually being sent over it.
const WS_URL_BASE = process.env.DERIV_WS_URL || 'wss://ws.derivws.com/websockets/v3';
const APP_ID = process.env.DERIV_WS_APP_ID || '1089';

let req_id_counter = 1;
const nextReqId = () => req_id_counter++;

/**
 * One DerivConnection == one authenticated WebSocket to Deriv for a single
 * account/token, shared by every strategy in a bulk run. Requests are
 * correlated by req_id; subscriptions (ticks, proposal_open_contract) push
 * repeated messages that are forwarded to their registered callback until
 * explicitly unsubscribed.
 */
export class DerivConnection {
    /**
     * @param {string} token - a Deriv API token (PAT) with at least the
     *   "trade" scope. Under the classic protocol a token authorizes exactly
     *   one login (there is no account-type selection step here — the token
     *   itself already identifies demo vs real).
     */
    constructor(token) {
        this.token = token;
        this.ws = null;
        this.pending = new Map(); // req_id -> { resolve, reject }
        this.subscriptions = new Map(); // req_id -> callback
        this.subscription_ids = new Map(); // req_id -> deriv subscription.id (for forget)
        this.isReady = false;
        this.onFatalError = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            const url = `${WS_URL_BASE}?app_id=${APP_ID}`;
            this.ws = new WebSocket(url);

            const authTimeout = setTimeout(() => {
                reject(new Error('Timed out waiting for Deriv to authorize this token'));
                try {
                    this.ws?.close();
                } catch {
                    // ignore
                }
            }, 15000);

            this.ws.on('open', () => {
                // eslint-disable-next-line no-console
                console.log('[derivConnection] connected, authorizing…');
                this.ws.send(JSON.stringify({ authorize: this.token, req_id: 0 }));
            });

            const onFirstMessage = raw => {
                let data;
                try {
                    data = JSON.parse(raw.toString());
                } catch {
                    return;
                }
                if (data.req_id !== 0) return; // not the authorize response — let _handleMessage take it

                clearTimeout(authTimeout);
                this.ws.off('message', onFirstMessage);
                this.ws.on('message', raw2 => this._handleMessage(raw2));

                if (data.error) {
                    reject(new Error(data.error.message || 'Deriv rejected this token'));
                    return;
                }

                this.isReady = true;
                resolve(data); // { authorize: { loginid, currency, balance, ... } }
            };
            this.ws.on('message', onFirstMessage);

            this.ws.on('error', err => {
                clearTimeout(authTimeout);
                if (!this.isReady) reject(err);
                this.onFatalError?.(err);
            });

            this.ws.on('close', () => {
                clearTimeout(authTimeout);
                this.isReady = false;
                this.onFatalError?.(new Error('Connection to Deriv closed'));
            });
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
            const req_id = data.req_id;
            if (req_id && this.pending.has(req_id)) {
                this.pending.get(req_id).reject(new Error(data.error.message || 'Deriv API error'));
                this.pending.delete(req_id);
                return;
            }
            if (req_id && this.subscriptions.has(req_id)) {
                this.subscriptions.get(req_id)(null, new Error(data.error.message || 'Deriv API error'));
                return;
            }
            return;
        }

        const req_id = data.req_id;

        // Track the deriv-assigned subscription id so we can forget() it later.
        if (data.subscription?.id && req_id && this.subscriptions.has(req_id)) {
            this.subscription_ids.set(req_id, data.subscription.id);
        }

        if (req_id && this.subscriptions.has(req_id)) {
            this.subscriptions.get(req_id)(data, null);
            // Don't also resolve `pending` below for the first push of a
            // subscription — subscribe() resolves separately on first message.
        }

        if (req_id && this.pending.has(req_id)) {
            this.pending.get(req_id).resolve(data);
            this.pending.delete(req_id);
        }
    }

    send(request) {
        return new Promise((resolve, reject) => {
            const req_id = nextReqId();
            this.pending.set(req_id, { resolve, reject });
            this.ws.send(JSON.stringify({ ...request, req_id }));
            setTimeout(() => {
                if (this.pending.has(req_id)) {
                    this.pending.delete(req_id);
                    reject(new Error('Deriv API request timed out'));
                }
            }, 15000);
        });
    }

    /**
     * Sends a subscribe:1 request. `onUpdate(data, error)` is called for every
     * push, including the first one. Returns the req_id, needed for unsubscribe().
     */
    subscribe(request, onUpdate) {
        const req_id = nextReqId();
        this.subscriptions.set(req_id, onUpdate);
        this.ws.send(JSON.stringify({ ...request, subscribe: 1, req_id }));
        return req_id;
    }

    async unsubscribe(req_id) {
        const sub_id = this.subscription_ids.get(req_id);
        this.subscriptions.delete(req_id);
        this.subscription_ids.delete(req_id);
        if (sub_id) {
            try {
                await this.send({ forget: sub_id });
            } catch {
                // best-effort — connection may already be closing
            }
        }
    }

    close() {
        this.isReady = false;
        try {
            this.ws?.close();
        } catch {
            // ignore
        }
    }
}
