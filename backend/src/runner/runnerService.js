// The server-side AI runner: the same engine as the browser (compiled by scripts/build-runner.mjs), running on this server
// so the AI keeps trading when the laptop or phone is closed.
//
// Safety rules baked in:
//  * Off unless RUNNER_KEY is set on the backend, and every call must present it (x-runner-key). See server.js.
//  * The Deriv token is held in this process's memory only: never written to disk or the database, never logged, never sent
//    back by any endpoint, and dropped the moment the run stops. A restart or deploy therefore stops the run (it does NOT resume
//    by itself), so nothing keeps trading with a token nobody can see.
//  * One run at a time. It trades only on the account it was started for (verified after connecting).
//  * The engine's own limits all apply (stop-loss floor, profit goal, trade pacing, capital protection...). On top of that the run
//    ends by itself after RUNNER_MAX_HOURS (default 24).
import crypto from 'node:crypto';

const MAX_ITEMS = 3000;

export class RunnerService {
    constructor({ marketFeed, port, key, connectionFactory, maxHours }) {
        this.feed = marketFeed;
        this.port = port;
        this.key = key || '';
        this.connectionFactory = connectionFactory || null; // tests inject a fake connection
        this.max_hours = Number(maxHours ?? process.env.RUNNER_MAX_HOURS ?? 24) || 24;
        this.mod = null;
        this._reset();
    }

    _reset() {
        this.state = 'idle'; // idle | starting | running | stopped | error
        this.account = '';
        this.started_at = null;
        this.stop_reason = '';
        this.error = '';
        this.items = []; // { seq, kind: 'event' | 'contract' | 'log', data }
        this.seq = 0;
        this.started_event = null;
        this.engine = null;
        this.connection = null;
        this.token = null;
        this.timer = null;
    }

    enabled() {
        return this.key.length > 0;
    }

    keyMatches(given) {
        const a = Buffer.from(String(given || ''));
        const b = Buffer.from(this.key);
        return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
    }

    async _load() {
        if (this.mod) return this.mod;
        // The engine reads these at import time, so they are set first.
        process.env.NEXT_PUBLIC_BULK_TRADER_API_URL = `http://127.0.0.1:${this.port}`;
        if (!globalThis.localStorage) {
            const m = new Map();
            globalThis.localStorage = {
                getItem: k => (m.has(k) ? m.get(k) : null),
                setItem: (k, v) => void m.set(k, String(v)),
                removeItem: k => void m.delete(k),
            };
        }
        if (!globalThis.sessionStorage) globalThis.sessionStorage = globalThis.localStorage;
        if (!globalThis.WebSocket) globalThis.WebSocket = (await import('ws')).default;
        this.mod = {
            engine: await import('./engine/autoPilotEngine.js'),
            client: await import('./engine/derivClient.js'),
            learning: await import('./engine/learningEngine.js'),
            rules: await import('./engine/contractRules.js'),
        };
        return this.mod;
    }

    _push(kind, data) {
        this.seq += 1;
        this.items.push({ seq: this.seq, kind, data });
        if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    }

    _snapshots() {
        const all = this.feed.getAllSnapshots();
        const out = {};
        for (const [symbol, snap] of Object.entries(all)) if (snap) out[symbol] = snap;
        return out;
    }

    async start({ token, account_id, config, learn_mode }) {
        if (this.state === 'starting' || this.state === 'running') throw new Error('The server runner is already running. Stop it first.');
        if (typeof token !== 'string' || token.length < 8) throw new Error('A Deriv token is required.');
        if (typeof account_id !== 'string' || !account_id) throw new Error('The account id to trade on is required.');
        if (!config || typeof config !== 'object' || !(Number(config.stake) > 0)) throw new Error('A valid AI configuration (with a stake) is required.');
        const mod = await this._load();
        this._reset();
        this.state = 'starting';
        this.account = account_id;
        this.token = token;
        try {
            // The browser build picks the account from localStorage.active_loginid; set it, then verify below.
            globalThis.localStorage.setItem('active_loginid', account_id);
            const connection = this.connectionFactory ? await this.connectionFactory(token, account_id) : new mod.client.DerivClientConnection(token);
            if (!this.connectionFactory) await connection.connect();
            this.connection = connection;
            if (connection.accountInfo?.loginid !== account_id) {
                connection.close?.();
                throw new Error(`Connected to account ${connection.accountInfo?.loginid ?? '?'} instead of ${account_id}. Not starting, so it cannot trade on the wrong account.`);
            }
            const balance = await connection.refreshBalance?.();
            if (balance == null && !connection.balanceLive) throw new Error('Could not read the live account balance from Deriv.');
            const currency = connection.accountInfo?.currency || 'USD';
            await mod.rules.loadLiveRules(Object.keys(this._snapshots()));
            const learner = new mod.learning.LearningEngine(await mod.learning.makeProfileId(account_id), learn_mode || 'learn');
            await learner.syncFromBackend();
            await learner.syncPaper();
            const hooks = {
                onContract: contract => this._push('contract', contract),
                onLog: (kind, message) => this._push('log', { ts: Date.now(), kind, text: message }),
                onSettled: () => {},
                gate: () => undefined, // the browser's journal-based gate does not exist on the server
            };
            const engine = new mod.engine.AutoPilotEngine(connection, currency, config, () => this._snapshots(), event => this._onEvent(event), learner, hooks);
            this.engine = engine;
            this.started_at = Date.now();
            this.state = 'running';
            this.timer = setTimeout(() => this.stop(`maximum run time of ${this.max_hours} hours reached`), this.max_hours * 3_600_000);
            this.timer.unref?.();
            this._push('log', { ts: Date.now(), kind: 'info', text: `Server runner started on ${account_id}. It keeps trading with your devices closed; it stops at ${this.max_hours} hours at the latest.` });
            engine.start();
        } catch (err) {
            this._finish('error', err instanceof Error ? err.message : String(err));
            throw err;
        }
    }

    _onEvent(event) {
        if (event.phase === 'started') this.started_event = event;
        this._push('event', event);
        if (event.phase === 'stopped') this._finish('stopped', event.reason || '');
        else if (event.phase === 'error') this._finish('error', event.error || 'error');
    }

    /** Ends the run: closes the connection and forgets the token. The items stay readable so the app can show how it ended. */
    _finish(state, reason) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        try {
            this.connection?.close?.();
        } catch {
            /* already closed */
        }
        this.connection = null;
        this.token = null;
        this.engine = null;
        this.state = state;
        if (state === 'stopped') this.stop_reason = reason;
        else this.error = reason;
    }

    stop(reason = 'stopped from the app') {
        if (this.engine) {
            this.engine.stop(reason); // emits the 'stopped' event, which calls _finish
        } else if (this.state === 'starting') {
            this._finish('stopped', reason);
        }
    }

    status(since = 0) {
        return {
            enabled: this.enabled(),
            state: this.state,
            running: this.state === 'running' || this.state === 'starting',
            account: this.account,
            started_at: this.started_at,
            max_hours: this.max_hours,
            stop_reason: this.stop_reason,
            error: this.error,
            started_event: this.started_event,
            seq: this.seq,
            items: this.items.filter(i => i.seq > since).slice(0, 800),
        };
    }
}
