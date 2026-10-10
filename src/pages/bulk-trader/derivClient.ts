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
    let accounts = stored && stored.length > 0 ? stored : await DerivWSAccountsService.fetchAccountsList(token);
    if (!accounts || accounts.length === 0) {
        throw new Error('No Deriv accounts found for this session. Try logging in again.');
    }
    const active_loginid = localStorage.getItem('active_loginid');
    if (!active_loginid) return accounts[0];
    let match = accounts.find(a => a.account_id === active_loginid);
    if (!match && stored && stored.length > 0) {
        // The stored list can be stale (an account added or switched since login): ask Deriv once before giving up.
        accounts = (await DerivWSAccountsService.fetchAccountsList(token)) ?? accounts;
        match = accounts.find(a => a.account_id === active_loginid);
    }
    // Never quietly use a different account (usually the first one, a demo) than the one the header shows.
    if (!match) throw new Error(`The account shown in the header (${active_loginid}) was not found for this login. Not connecting, so the AI cannot trade on another account.`);
    return match;
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
    /** Fires with the LIVE account balance now and after every change (trades, deposits, other tabs). */
    onBalance: ((balance: number, currency: string, loginid: string) => void) | null = null;
    /** False until Deriv has actually sent a balance; until then `accountInfo.balance` is only the login-time cache. */
    balanceLive = false;
    private closed_on_purpose = false;
    private reconnecting = false;
    private wake: (() => void) | null = null;
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

        const wsUrl = await DerivWSAccountsService.fetchOTPWebSocketURL(this.token, account.account_id, { fresh: true });
        await this._open(wsUrl, true);
        // The balance in the stored accounts list is a snapshot from login time. Replace it with the
        // real one from Deriv and keep it updating, so the AI sees what the account really holds.
        await this._startBalanceStream();
        // A background tab or a sleeping phone can have its socket closed while its timers are paused.
        // The moment the page is visible / online again, bring the connection back instead of waiting.
        if (typeof window !== 'undefined' && !this.wake) {
            this.wake = () => {
                if (this.closed_on_purpose || this.isReady || this.reconnecting) return;
                if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
                void this._reconnect();
            };
            window.addEventListener('online', this.wake);
            document.addEventListener('visibilitychange', this.wake);
        }
        return { authorize: this.accountInfo as TDerivAccountInfo };
    }

    /**
     * Subscribes to Deriv's `balance` stream for this account. Resolves after the first live value
     * (or after 4s / an error, in which case the login-time cache stays and `balanceLive` is false).
     * The subscription is re-opened automatically after a reconnect.
     */
    private _startBalanceStream(): Promise<void> {
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
                    // Never accept a balance that belongs to a different account than this connection's.
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

    /** One-off live balance read (used right before starting a run). Returns null if Deriv does not answer. */
    async refreshBalance(): Promise<number | null> {
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
        if (this.reconnecting) return;
        this.reconnecting = true;
        try {
            await this._reconnectLoop();
        } finally {
            this.reconnecting = false;
        }
    }

    private async _reconnectLoop() {
        this.onReconnecting?.();
        for (let attempt = 0; attempt < 10; attempt++) {
            if (this.closed_on_purpose) return;
            await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
            try {
                const wsUrl = await DerivWSAccountsService.fetchOTPWebSocketURL(this.token, this.accountInfo?.account_id ?? '', { fresh: true });
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
        if (this.wake && typeof window !== 'undefined') {
            window.removeEventListener('online', this.wake);
            document.removeEventListener('visibilitychange', this.wake);
            this.wake = null;
        }
        this.onBalance = null;
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
