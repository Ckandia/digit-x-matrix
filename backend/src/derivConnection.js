import WebSocket from 'ws';

const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3';
const APP_ID = process.env.DERIV_APP_ID || '1089'; // 1089 is Deriv's public demo app id fallback

let req_id_counter = 1;
const nextReqId = () => req_id_counter++;

/**
 * One DerivConnection == one authorized WebSocket to Deriv for a single
 * account/token, shared by every strategy in a bulk run. Requests are
 * correlated by req_id; subscriptions (ticks, proposal_open_contract) push
 * repeated messages that are forwarded to their registered callback until
 * explicitly unsubscribed.
 */
export class DerivConnection {
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
            this.ws = new WebSocket(`${DERIV_WS_URL}?app_id=${APP_ID}`);

            this.ws.on('open', async () => {
                try {
                    const auth = await this.send({ authorize: this.token });
                    this.isReady = true;
                    resolve(auth);
                } catch (err) {
                    reject(err);
                }
            });

            this.ws.on('message', raw => this._handleMessage(raw));

            this.ws.on('error', err => {
                if (!this.isReady) reject(err);
                this.onFatalError?.(err);
            });

            this.ws.on('close', () => {
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
