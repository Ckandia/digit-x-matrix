// A Node version of the browser's DerivClientConnection (src/pages/bulk-trader/derivClient.ts), with the same methods the AI
// engine calls: send / subscribe / unsubscribe / refreshBalance / close and the onFatalError / onReconnecting / onReconnect
// callbacks. It never writes a token, an OTP or a socket URL to any log.
import WebSocket from 'ws';

const API_BASE = {
    production: 'https://api.derivws.com/trading/v1/options/',
    preview: 'https://staging-api.derivws.com/trading/v1/options/',
};
export const derivEnv = () => (process.env.DERIV_ENV === 'preview' ? 'preview' : 'production');
export const derivApiBase = () => process.env.DERIV_API_BASE || API_BASE[derivEnv()];

let req_id_counter = 1;
const nextReqId = () => req_id_counter++;

export async function fetchAccounts(accessToken, fetchImpl = fetch) {
    const res = await fetchImpl(`${derivApiBase()}accounts`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Deriv accounts request failed (${res.status})`);
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
}

async function fetchOtpUrl(accessToken, accountId, fetchImpl = fetch) {
    const res = await fetchImpl(`${derivApiBase()}accounts/${encodeURIComponent(accountId)}/otp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Deriv OTP request failed (${res.status})`);
    const body = await res.json();
    const url = body?.data?.url;
    if (!url) throw new Error('Deriv did not return a WebSocket URL');
    return url;
}

export class DerivClientConnection {
    /**
     * @param {() => Promise<string>} getToken returns a currently valid access token (refreshing it when needed)
     * @param {string} loginid the account to trade on; the connection refuses to fall back to a different one
     * @param {{ fetchImpl?: typeof fetch, wsFactory?: (url: string) => any }} [deps] for tests
     */
    constructor(getToken, loginid, deps = {}) {
        this.getToken = getToken;
        this.loginid = loginid;
        this.fetchImpl = deps.fetchImpl || fetch;
        this.wsFactory = deps.wsFactory || (url => new WebSocket(url));
        this.ws = null;
        this.pending = new Map();
        this.subscriptions = new Map();
        this.subscription_ids = new Map();
        this.sub_requests = new Map();
        this.isReady = false;
        this.balanceLive = false;
        this.accountInfo = null;
        this.onFatalError = null;
        this.onReconnecting = null;
        this.onReconnect = null;
        this.onBalance = null;
        this.closed_on_purpose = false;
        this.reconnecting = false;
        this.keepalive = null;
    }

    async connect() {
        const token = await this.getToken();
        const accounts = await fetchAccounts(token, this.fetchImpl);
        const account = accounts.find(a => a.account_id === this.loginid);
        if (!account) throw new Error(`Account ${this.loginid} was not found for this login. Not connecting.`);
        this.accountInfo = {
            account_id: account.account_id,
            loginid: account.account_id,
            currency: account.currency,
            balance: Number(account.balance),
            type: account.account_type,
        };
        await this._open(await fetchOtpUrl(token, account.account_id, this.fetchImpl), true);
        await this._startBalanceStream();
        return { authorize: this.accountInfo };
    }

    _startBalanceStream() {
        return new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, 4000);
            this.subscribe({ balance: 1 }, (data, err) => {
                const b = data?.balance;
                if (!err && b && Number.isFinite(Number(b.balance))) {
                    const loginid = String(b.loginid || this.accountInfo?.loginid || '');
                    if (!this.accountInfo || !loginid || loginid === this.accountInfo.loginid) {
                        const currency = String(b.currency || this.accountInfo?.currency || 'USD');
                        if (this.accountInfo) this.accountInfo = { ...this.accountInfo, balance: Number(b.balance), currency };
                        this.balanceLive = true;
                        this.onBalance?.(Number(b.balance), currency, loginid);
                    }
                }
                finish();
            });
        });
    }

    async refreshBalance() {
        try {
            const res = await this.send({ balance: 1 });
            const value = Number(res?.balance?.balance);
            if (Number.isFinite(value) && this.accountInfo) {
                this.accountInfo = { ...this.accountInfo, balance: value };
                this.balanceLive = true;
                return value;
            }
        } catch {
            /* keep the last known balance */
        }
        return null;
    }

    _open(wsUrl, first) {
        return new Promise((resolve, reject) => {
            const ws = this.wsFactory(wsUrl);
            this.ws = ws;
            let opened = false;
            ws.on('open', () => {
                opened = true;
                this.isReady = true;
                this._startKeepAlive();
                resolve();
            });
            ws.on('message', data => this._handleMessage(String(data)));
            ws.on('error', () => {
                if (!opened) reject(new Error('Could not connect to Deriv.'));
            });
            ws.on('close', () => {
                this.isReady = false;
                this._stopKeepAlive();
                if (this.ws !== ws) return;
                if (!opened && first) return;
                if (this.closed_on_purpose) return;
                for (const [id, p] of this.pending) {
                    p.reject(new Error('Connection to Deriv dropped while waiting for a reply'));
                    this.pending.delete(id);
                }
                void this._reconnect();
            });
        });
    }

    _startKeepAlive() {
        this._stopKeepAlive();
        this.keepalive = setInterval(() => {
            try {
                if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ ping: 1 }));
            } catch {
                /* the close handler deals with it */
            }
        }, 25000);
        this.keepalive.unref?.();
    }

    _stopKeepAlive() {
        if (this.keepalive) clearInterval(this.keepalive);
        this.keepalive = null;
    }

    async _reconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;
        try {
            this.onReconnecting?.();
            // A server must out-wait a longer Deriv blip than a phone does: back off up to 30s, for about 10 minutes.
            for (let attempt = 0; attempt < 30; attempt++) {
                if (this.closed_on_purpose) return;
                await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 30000)));
                if (this.closed_on_purpose) return;
                try {
                    const token = await this.getToken();
                    await this._open(await fetchOtpUrl(token, this.accountInfo?.account_id ?? this.loginid, this.fetchImpl), false);
                    for (const [req_id, request] of this.sub_requests) {
                        this.ws?.send(JSON.stringify({ ...request, subscribe: 1, req_id }));
                    }
                    this.onReconnect?.();
                    return;
                } catch {
                    /* try again */
                }
            }
            this.onFatalError?.(new Error('Connection to Deriv closed'));
        } finally {
            this.reconnecting = false;
        }
    }

    _handleMessage(raw) {
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }
        const req_id = data.req_id;
        if (data.error) {
            if (req_id && this.pending.has(req_id)) {
                this.pending.get(req_id).reject(new Error(data.error.message || 'Deriv API error'));
                this.pending.delete(req_id);
            } else if (req_id && this.subscriptions.has(req_id)) {
                this.subscriptions.get(req_id)(null, new Error(data.error.message || 'Deriv API error'));
            }
            return;
        }
        if (data.subscription?.id && req_id && this.subscriptions.has(req_id)) this.subscription_ids.set(req_id, data.subscription.id);
        if (req_id && this.subscriptions.has(req_id)) this.subscriptions.get(req_id)(data, null);
        if (req_id && this.pending.has(req_id)) {
            this.pending.get(req_id).resolve(data);
            this.pending.delete(req_id);
        }
    }

    send(request) {
        return new Promise((resolve, reject) => {
            const req_id = nextReqId();
            this.pending.set(req_id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify({ ...request, req_id }));
            } catch (err) {
                this.pending.delete(req_id);
                reject(err instanceof Error ? err : new Error('Could not send to Deriv'));
                return;
            }
            const t = setTimeout(() => {
                if (this.pending.has(req_id)) {
                    this.pending.delete(req_id);
                    reject(new Error('Deriv API request timed out'));
                }
            }, 15000);
            t.unref?.();
        });
    }

    subscribe(request, onUpdate) {
        const req_id = nextReqId();
        this.subscriptions.set(req_id, onUpdate);
        this.sub_requests.set(req_id, request);
        try {
            this.ws?.send(JSON.stringify({ ...request, subscribe: 1, req_id }));
        } catch {
            /* re-sent after a reconnect */
        }
        return req_id;
    }

    async unsubscribe(req_id) {
        const sub_id = this.subscription_ids.get(req_id);
        this.subscriptions.delete(req_id);
        this.sub_requests.delete(req_id);
        this.subscription_ids.delete(req_id);
        if (sub_id) {
            try {
                await this.send({ forget: sub_id });
            } catch {
                /* the connection may already be closing */
            }
        }
    }

    close() {
        this.closed_on_purpose = true;
        this.onBalance = null;
        this.onFatalError = null;
        this._stopKeepAlive();
        this.isReady = false;
        try {
            this.ws?.close();
        } catch {
            /* ignore */
        }
    }
}
