import WebSocket from 'ws';

// Deriv migrated authenticated trading to this REST + OTP flow — the old
// single-step `{"authorize": token}` WebSocket handshake on
// ws.derivws.com/websockets/v3 is what was producing "Input validation
// failed" errors; that message format is no longer accepted. The new flow:
//   1. GET  /trading/v1/options/accounts            -> list this token's accounts
//   2. POST /trading/v1/options/accounts/{id}/otp   -> one-time WS URL
//   3. Connect directly to that URL — it's already authenticated, no
//      separate "authorize" message is sent or needed.
const API_BASE = 'https://api.derivws.com';
const APP_ID = process.env.DERIV_APP_ID || '1089';

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
     *   "trade" scope.
     * @param {{ accountType?: 'demo'|'real', accountId?: string }} [options]
     *   accountType: which kind of account to use if the token has access to
     *   more than one (defaults to 'demo' — deliberately safe-by-default so
     *   a bulk run never lands on real money unless explicitly asked for).
     *   accountId: pin an exact account id instead of picking by type.
     */
    constructor(token, options = {}) {
        this.token = token;
        this.preferredAccountType = options.accountType || 'demo';
        this.preferredAccountId = options.accountId || null;
        this.ws = null;
        this.pending = new Map(); // req_id -> { resolve, reject }
        this.subscriptions = new Map(); // req_id -> callback
        this.subscription_ids = new Map(); // req_id -> deriv subscription.id (for forget)
        this.isReady = false;
        this.onFatalError = null;
        this.accountInfo = null; // { account_id, loginid, currency, balance, type }
    }

    async _restCall(path, requestOptions = {}) {
        const res = await fetch(`${API_BASE}${path}`, {
            ...requestOptions,
            headers: {
                Authorization: `Bearer ${this.token}`,
                'Deriv-App-ID': APP_ID,
                'Content-Type': 'application/json',
                ...(requestOptions.headers || {}),
            },
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const message = body?.error?.message || body?.message || `Deriv REST call failed (HTTP ${res.status})`;
            throw new Error(message);
        }
        return body;
    }

    /**
     * Fetches this token's Options trading accounts and picks one — by exact
     * accountId if given, otherwise the first account matching
     * preferredAccountType, otherwise the first account of any type (with a
     * clear log line either way so the choice is never silent).
     */
    async _resolveAccount() {
        const body = await this._restCall('/trading/v1/options/accounts', { method: 'GET' });
        const accounts = body?.data ?? body?.accounts ?? (Array.isArray(body) ? body : []);
        if (!Array.isArray(accounts) || accounts.length === 0) {
            throw new Error(
                'No Options trading accounts found for this token. Make sure the token has the "trade" scope.'
            );
        }

        let account = null;
        if (this.preferredAccountId) {
            account = accounts.find(a => (a.account_id || a.id) === this.preferredAccountId) || null;
            if (!account) {
                throw new Error(`No account found matching accountId "${this.preferredAccountId}".`);
            }
        } else {
            account =
                accounts.find(a => (a.type || a.account_type) === this.preferredAccountType) || accounts[0];
        }

        const account_id = account.account_id || account.id;
        if (!account_id) throw new Error('Could not determine an account_id from the Deriv accounts response.');

        const resolved = {
            account_id,
            loginid: account.loginid || account.login_id || account_id,
            currency: account.currency,
            balance: account.balance,
            type: account.type || account.account_type,
        };
        // eslint-disable-next-line no-console
        console.log(
            `[derivConnection] Using Options account: ${resolved.loginid} (${resolved.type}, ${resolved.currency})`
        );
        return resolved;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            (async () => {
                try {
                    this.accountInfo = await this._resolveAccount();

                    const otpBody = await this._restCall(
                        `/trading/v1/options/accounts/${this.accountInfo.account_id}/otp`,
                        { method: 'POST' }
                    );
                    const wsUrl = otpBody?.data?.url || otpBody?.url;
                    if (!wsUrl) throw new Error('Deriv OTP response did not include a WebSocket URL.');

                    this.ws = new WebSocket(wsUrl);

                    this.ws.on('open', () => {
                        // The OTP-signed URL is already authenticated — there is no
                        // separate "authorize" request in the new API. Resolve with
                        // the same { authorize: { loginid, currency, ... } } shape
                        // the rest of the backend (runner.js) already expects.
                        this.isReady = true;
                        resolve({ authorize: this.accountInfo });
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
                } catch (err) {
                    reject(err);
                }
            })();
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
