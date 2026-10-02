// Runs entirely in the browser. Opens a second, independent authenticated
// WebSocket to Deriv for Bulk Trades / the AI executor — independent because
// the main app's own connection (api-base.ts) is a singleton built to run
// one bot at a time, and bulk runs need several StrategyEngines trading
// concurrently. It authenticates the exact same way api-base.ts does: reuse
// DerivWSAccountsService (already used by src/components/shared/utils/config/config.ts
// for the main engine) rather than re-implementing the OTP handshake here.
//
// Trades on whichever account is currently active in the app (the same
// account the header's account switcher shows) — there's no separate
// account picker in Bulk Trader, so switching accounts in the header before
// starting a run is what controls demo vs real, exactly like the main bot
// engine.
import { DerivWSAccountsService, DerivAccount } from '@/services/derivws-accounts.service';

let req_id_counter = 1;
const nextReqId = () => req_id_counter++;

export type TDerivAccountInfo = {
    account_id: string;
    loginid: string;
    currency: string;
    balance?: number;
    type?: string;
};

type TPending = { resolve: (v: any) => void; reject: (e: Error) => void };
type TOnUpdate = (data: any, error: Error | null) => void;

const resolveActiveAccount = async (token: string): Promise<DerivAccount> => {
    // An empty stored list counts as "nothing stored" — fall through to a
    // fresh fetch instead of failing on it.
    const stored = DerivWSAccountsService.getStoredAccounts();
    const accounts = stored && stored.length > 0 ? stored : await DerivWSAccountsService.fetchAccountsList(token);
    if (!accounts || accounts.length === 0) {
        throw new Error('No Deriv accounts found for this session. Try logging in again.');
    }
    const active_loginid = localStorage.getItem('active_loginid');
    return accounts.find(a => a.account_id === active_loginid) ?? accounts[0];
};

/**
 * One DerivClientConnection == one authenticated WebSocket to Deriv for the
 * currently active account, shared by every strategy in a bulk run or by the
 * AI executor. Requests are correlated by req_id; subscriptions (ticks,
 * proposal_open_contract) push repeated messages forwarded to their
 * registered callback until explicitly unsubscribed.
 */
export class DerivClientConnection {
    token: string;
    ws: WebSocket | null = null;
    pending = new Map<number, TPending>();
    subscriptions = new Map<number, TOnUpdate>();
    subscription_ids = new Map<number, string>();
    isReady = false;
    sub_requests = new Map<number, Record<string, unknown>>(); // so subscriptions survive a reconnect
    onFatalError: ((err: Error) => void) | null = null;
    onReconnecting: (() => void) | null = null;
    onReconnect: (() => void) | null = null;
    private closed_on_purpose = false;
    private keepalive: ReturnType<typeof setInterval> | null = null;
    accountInfo: TDerivAccountInfo | null = null;

    constructor(token: string) {
        this.token = token;
    }

    async connect(): Promise<{ authorize: TDerivAccountInfo }> {
        const account = await resolveActiveAccount(this.token);
        this.accountInfo = {
            account_id: account.account_id,
            loginid: account.account_id,
            currency: account.currency,
            balance: Number(account.balance),
            type: account.account_type,
        };

        const wsUrl = await DerivWSAccountsService.fetchOTPWebSocketURL(this.token, account.account_id);
        await this._open(wsUrl, true);
        return { authorize: this.accountInfo as TDerivAccountInfo };
    }

    /** Opens the socket. The OTP-signed URL is already authenticated: no separate "authorize" request. */
    private _open(wsUrl: string, first: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            this.ws = ws;
            let opened = false;

            ws.onopen = () => {
                opened = true;
                this.isReady = true;
                this._startKeepAlive();
                resolve();
            };

            ws.onmessage = event => this._handleMessage(event.data);

            ws.onerror = () => {
                if (!opened) reject(new Error('Could not connect to Deriv.'));
            };

            ws.onclose = () => {
                this.isReady = false;
                this._stopKeepAlive();
                if (this.ws !== ws) return; // an old socket we already replaced
                if (!opened && first) return; // initial connect failure is reported by reject()
                if (this.closed_on_purpose) return;
                // Anything waiting on a reply from the dead socket can never get one.
                for (const [id, p] of this.pending) {
                    p.reject(new Error('Connection to Deriv dropped while waiting for a reply'));
                    this.pending.delete(id);
                }
                void this._reconnect();
            };
        });
    }

    /** Deriv closes idle sockets, so ping every 25s while open. */
    private _startKeepAlive() {
        this._stopKeepAlive();
        this.keepalive = setInterval(() => {
            try {
                if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ ping: 1 }));
            } catch {
                /* the close handler deals with it */
            }
        }, 25000);
    }

    private _stopKeepAlive() {
        if (this.keepalive) clearInterval(this.keepalive);
        this.keepalive = null;
    }

    /** Up to 5 attempts with a fresh login URL each time (the URL is single-use), then gives up. */
    private async _reconnect() {
        this.onReconnecting?.();
        for (let attempt = 0; attempt < 5; attempt++) {
            if (this.closed_on_purpose) return;
            await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
            try {
                const wsUrl = await DerivWSAccountsService.fetchOTPWebSocketURL(this.token, this.accountInfo?.account_id ?? '');
                await this._open(wsUrl, false);
                // Re-open every live subscription (ticks, open contracts) under the same req_ids.
                // An open contract that settled while we were away is reported again as sold.
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
    }

    _handleMessage(raw: string) {
        let data: any;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }

        if (data.error) {
            const req_id = data.req_id;
            if (req_id && this.pending.has(req_id)) {
                this.pending.get(req_id)!.reject(new Error(data.error.message || 'Deriv API error'));
                this.pending.delete(req_id);
                return;
            }
            if (req_id && this.subscriptions.has(req_id)) {
                this.subscriptions.get(req_id)!(null, new Error(data.error.message || 'Deriv API error'));
                return;
            }
            return;
        }

        const req_id = data.req_id;

        if (data.subscription?.id && req_id && this.subscriptions.has(req_id)) {
            this.subscription_ids.set(req_id, data.subscription.id);
        }

        if (req_id && this.subscriptions.has(req_id)) {
            this.subscriptions.get(req_id)!(data, null);
        }

        if (req_id && this.pending.has(req_id)) {
            this.pending.get(req_id)!.resolve(data);
            this.pending.delete(req_id);
        }
    }

    send(request: Record<string, unknown>): Promise<any> {
        return new Promise((resolve, reject) => {
            const req_id = nextReqId();
            this.pending.set(req_id, { resolve, reject });
            this.ws?.send(JSON.stringify({ ...request, req_id }));
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
    subscribe(request: Record<string, unknown>, onUpdate: TOnUpdate): number {
        const req_id = nextReqId();
        this.subscriptions.set(req_id, onUpdate);
        this.sub_requests.set(req_id, request);
        this.ws?.send(JSON.stringify({ ...request, subscribe: 1, req_id }));
        return req_id;
    }

    async unsubscribe(req_id: number) {
        const sub_id = this.subscription_ids.get(req_id);
        this.subscriptions.delete(req_id);
        this.sub_requests.delete(req_id);
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
        this.closed_on_purpose = true;
        this._stopKeepAlive();
        this.isReady = false;
        this.onFatalError = null; // this is a deliberate close, not a fatal error
        try {
            this.ws?.close();
        } catch {
            // ignore
        }
    }
}
