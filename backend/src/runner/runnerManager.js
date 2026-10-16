// Runs the AI auto-pilot on the server, so a run keeps trading when the browser, laptop or phone that started it is closed.
//
// What lives here:
//  - one run per Deriv account (loginid), each with its OWN Deriv connection, trading on that account only;
//  - the Deriv login the run needs (access token + refresh token), kept in memory, refreshed before it expires, and, only
//    when RUNNER_ENC_KEY and a database are set, saved AES-256-GCM encrypted so a server restart can resume the run;
//  - a control secret created at start and returned once: status and stop need it. It controls the run, it is not a Deriv token.
// Tokens, one-time socket URLs and the control secret are never logged or returned.
import crypto from 'node:crypto';
import { getPool } from '../db.js';
import { upsertTrades } from '../tradeStore.js';
import { DerivClientConnection as NodeConnection, derivEnv, fetchAccounts } from './derivServerConnection.js';

const MAX_RUNS = Math.max(1, Number(process.env.RUNNER_MAX_RUNS || 3) || 3);
const KEEP_FINISHED_MS = 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const MIN_STAKE = 0.35;
const LEARN_MODES = new Set(['off', 'learn', 'edge_gate']);

const AUTH_BASE = { production: 'https://auth.deriv.com/oauth2', preview: 'https://staging-auth.deriv.com/oauth2' };
const authBase = () => process.env.DERIV_AUTH_URL || AUTH_BASE[derivEnv()];

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => {
    const x = sha(a);
    const y = sha(b);
    return crypto.timingSafeEqual(x, y);
};

// ---- Deriv login kept for the run ---------------------------------------------------------------------------------------
class TokenSession {
    constructor(tokens, { fetchImpl = fetch, onUpdate } = {}) {
        this.access_token = tokens.access_token;
        this.refresh_token = tokens.refresh_token || '';
        this.expires_at = Number(tokens.expires_at) || 0; // epoch seconds, as Deriv returns it
        this.fetchImpl = fetchImpl;
        this.onUpdate = onUpdate;
        this.inflight = null;
        this.last_error = null;
    }

    get canRefresh() {
        return !!(this.refresh_token && process.env.DERIV_APP_ID);
    }

    async getToken() {
        const left = this.expires_at ? this.expires_at * 1000 - Date.now() : Infinity;
        if (left > REFRESH_MARGIN_MS || !this.canRefresh) return this.access_token;
        return this.refresh();
    }

    refresh() {
        if (this.inflight) return this.inflight;
        this.inflight = (async () => {
            try {
                const body = new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: this.refresh_token,
                    client_id: process.env.DERIV_APP_ID,
                });
                const res = await this.fetchImpl(`${authBase()}/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: body.toString(),
                });
                if (!res.ok) throw new Error(`Deriv token refresh failed (${res.status})`);
                const t = await res.json();
                if (!t?.access_token) throw new Error('Deriv token refresh returned no token');
                this.access_token = t.access_token;
                if (t.refresh_token) this.refresh_token = t.refresh_token; // Deriv rotates it: always keep the newest
                this.expires_at = Number(t.expires_at) || Math.floor(Date.now() / 1000) + (Number(t.expires_in) || 3600);
                this.last_error = null;
                this.onUpdate?.();
                return this.access_token;
            } catch (err) {
                this.last_error = err instanceof Error ? err.message : 'token refresh failed';
                // A token that has not expired yet still works for this call; only a dead one is a real failure.
                if (this.expires_at * 1000 > Date.now()) return this.access_token;
                throw err;
            } finally {
                this.inflight = null;
            }
        })();
        return this.inflight;
    }
}

// ---- encrypted persistence (optional) -----------------------------------------------------------------------------------
const encKey = () => {
    const k = process.env.RUNNER_ENC_KEY || '';
    return k.length >= 16 ? sha(k) : null;
};
export const persistenceEnabled = () => !!(encKey() && getPool());

export const encrypt = (obj, key = encKey()) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
};
export const decrypt = (text, key = encKey()) => {
    const buf = Buffer.from(text, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
};

let table_ready = false;
const ensureTable = async pool => {
    if (table_ready) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_runner_sessions (loginid TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    table_ready = true;
};
const saveSession = async (loginid, record) => {
    if (!persistenceEnabled()) return;
    try {
        const pool = getPool();
        await ensureTable(pool);
        await pool.query(
            `INSERT INTO ai_runner_sessions (loginid, payload, updated_at) VALUES ($1, $2, now())
             ON CONFLICT (loginid) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
            [loginid, encrypt(record)]
        );
    } catch (err) {
        console.error('[runner] could not save the run:', err.message);
    }
};
const deleteSession = async loginid => {
    if (!persistenceEnabled()) return;
    try {
        const pool = getPool();
        await ensureTable(pool);
        await pool.query('DELETE FROM ai_runner_sessions WHERE loginid = $1', [loginid]);
    } catch (err) {
        console.error('[runner] could not clear the saved run:', err.message);
    }
};

// ---- input checks --------------------------------------------------------------------------------------------------------
const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Returns an error string, or null when the config is safe to run. The browser's own checks are not trusted. */
export const validateConfig = config => {
    if (!config || typeof config !== 'object') return 'Missing config';
    if (!finite(config.stake) || config.stake < MIN_STAKE) return `stake must be at least ${MIN_STAKE}`;
    if (!finite(config.stop_loss) || config.stop_loss <= 0) return 'A stop loss is required for a run that trades unattended';
    if (!finite(config.take_profit) || config.take_profit <= 0) return 'take_profit must be a positive number';
    if (config.stake > config.stop_loss) return 'stake cannot be larger than the stop loss';
    if (config.max_steps !== undefined && (!finite(config.max_steps) || config.max_steps < 1 || config.max_steps > 20)) return 'max_steps must be 1-20';
    if (config.martingale_multiplier !== undefined && (!finite(config.martingale_multiplier) || config.martingale_multiplier < 1 || config.martingale_multiplier > 5))
        return 'martingale_multiplier must be 1-5';
    return null;
};

const cleanTokens = body => {
    const t = body?.auth;
    if (!t || typeof t.access_token !== 'string' || t.access_token.length < 10 || t.access_token.length > 4096) return null;
    return {
        access_token: t.access_token,
        refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token.slice(0, 4096) : '',
        expires_at: finite(t.expires_at) ? t.expires_at : 0,
    };
};

// ---- the manager ---------------------------------------------------------------------------------------------------------
export class RunnerManager {
    /**
     * @param {{ getSnapshots: () => object, loadEngine: () => Promise<{ ServerRun: any }>, ConnectionClass?: any, fetchImpl?: typeof fetch, now?: () => number }} deps
     */
    constructor(deps) {
        this.getSnapshots = deps.getSnapshots;
        this.loadEngine = deps.loadEngine;
        this.ConnectionClass = deps.ConnectionClass || NodeConnection;
        this.fetchImpl = deps.fetchImpl || fetch;
        this.runs = new Map(); // loginid -> { run, tokens, secret_hash, config, learnMode, started_at, finished_at }
        this.start_calls = [];
    }

    enabled() {
        return process.env.RUNNER_ENABLED === 'true';
    }

    /** Proves the caller owns the Deriv login (Deriv answers for that token) and returns the account, or throws. */
    async verifyOwnership(tokens, loginid) {
        let accounts;
        try {
            accounts = await fetchAccounts(tokens.access_token, this.fetchImpl);
        } catch (err) {
            throw Object.assign(new Error('Deriv did not accept that login. Log in again and retry.'), { status: 401 });
        }
        const account = accounts.find(a => a.account_id === loginid);
        if (!account) throw Object.assign(new Error('That Deriv login does not own this account'), { status: 403 });
        return account;
    }

    async start(body) {
        if (!this.enabled()) throw Object.assign(new Error('Server trading is switched off (set RUNNER_ENABLED=true on the backend)'), { status: 503 });
        const loginid = typeof body?.loginid === 'string' && /^[A-Za-z0-9_-]{3,32}$/.test(body.loginid) ? body.loginid : null;
        if (!loginid) throw Object.assign(new Error('Missing or invalid loginid'), { status: 400 });
        const tokens = cleanTokens(body);
        if (!tokens) throw Object.assign(new Error('Missing Deriv login'), { status: 400 });
        const bad = validateConfig(body.config);
        if (bad) throw Object.assign(new Error(bad), { status: 400 });
        const learnMode = LEARN_MODES.has(body.learnMode) ? body.learnMode : 'learn';

        const now = Date.now();
        this.start_calls = this.start_calls.filter(t => now - t < 60_000);
        if (this.start_calls.length >= 10) throw Object.assign(new Error('Too many start requests'), { status: 429 });
        this.start_calls.push(now);

        const existing = this.runs.get(loginid);
        if (existing?.run.isRunning) throw Object.assign(new Error('A server run is already trading this account. Stop it first.'), { status: 409 });
        const live = [...this.runs.values()].filter(r => r.run.isRunning).length;
        if (live >= MAX_RUNS) throw Object.assign(new Error('The server is at its limit of simultaneous runs'), { status: 429 });

        const account = await this.verifyOwnership(tokens, loginid);
        const secret = crypto.randomBytes(24).toString('hex');
        await this._launch({
            loginid,
            currency: account.currency || 'USD',
            tokens,
            config: body.config,
            learnMode,
            secret_hash: sha(secret).toString('hex'),
            carried_profit: 0,
        });
        return { loginid, secret };
    }

    async _launch({ loginid, currency, tokens, config, learnMode, secret_hash, carried_profit }) {
        const { ServerRun } = await this.loadEngine();
        const session = new TokenSession(tokens, { fetchImpl: this.fetchImpl, onUpdate: () => void persist() });
        const connection = new this.ConnectionClass(() => session.getToken(), loginid, { fetchImpl: this.fetchImpl });
        const record = { loginid, tokens: session, config, learnMode, secret_hash, started_at: Date.now(), finished_at: 0, run: null, currency };
        let last_saved_profit = null;
        const persist = () => {
            if (record.finished_at) return;
            void saveSession(loginid, {
                loginid,
                currency,
                tokens: { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at },
                config,
                learnMode,
                secret_hash,
                carried_profit: record.run?.getState().totalProfit ?? carried_profit,
            });
        };
        // Config the engine sees: what is left of the loss/profit limits after what an earlier part of this run already did.
        const engine_config = { ...config, stop_loss: config.stop_loss + carried_profit, take_profit: config.take_profit - carried_profit };
        record.run = new ServerRun({
            connection,
            currency,
            loginid,
            config: engine_config,
            learnMode,
            carried_profit,
            getSnapshots: this.getSnapshots,
            onChange: state => {
                if (state.status === 'stopped' || state.status === 'error') {
                    if (!record.finished_at) {
                        record.finished_at = Date.now();
                        void deleteSession(loginid); // a finished run is never resumed
                    }
                } else if (state.totalProfit !== last_saved_profit) {
                    last_saved_profit = state.totalProfit;
                    persist();
                }
            },
            onSettled: trade => {
                void upsertTrades([
                    {
                        id: trade.contract_id,
                        account: loginid,
                        symbol: trade.symbol,
                        type: trade.contract_type,
                        stake: trade.stake,
                        payout: trade.payout,
                        profit: trade.profit,
                        buy_ts: trade.buy_ts,
                        sell_ts: trade.sell_ts,
                        ticks: trade.duration_ticks,
                        source: 'ai',
                        ai: { strategy: trade.strategy, step: trade.step, base_stake: trade.base_stake, mode: trade.mode, confidence: trade.confidence, tag: trade.tag },
                    },
                ]).catch(err => console.error('[runner] could not store a trade:', err.message));
            },
        });
        this.runs.set(loginid, record);
        try {
            await connection.connect();
            await record.run.start();
        } catch (err) {
            record.finished_at = Date.now();
            record.run.stop('could not start: ' + (err instanceof Error ? err.message : 'unknown error'));
            this.runs.delete(loginid);
            await deleteSession(loginid);
            throw Object.assign(new Error(err instanceof Error ? err.message : 'Could not start'), { status: 502 });
        }
        persist();
    }

    _auth(loginid, secret) {
        const rec = this.runs.get(loginid);
        if (!rec || typeof secret !== 'string' || !secret) return null;
        return safeEqual(sha(secret).toString('hex'), rec.secret_hash) ? rec : null;
    }

    status(loginid, secret) {
        const rec = this._auth(loginid, secret);
        if (!rec) return null;
        return {
            ...rec.run.getState(),
            loginid,
            currency: rec.currency,
            running: rec.run.isRunning,
            token: { can_refresh: rec.tokens.canRefresh, expires_at: rec.tokens.expires_at, last_error: rec.tokens.last_error },
            config: { stake: rec.config.stake, stop_loss: rec.config.stop_loss, take_profit: rec.config.take_profit },
        };
    }

    stop(loginid, secret) {
        const rec = this._auth(loginid, secret);
        if (!rec) return false;
        rec.run.stop('stopped by user');
        return true;
    }

    /** Drops finished runs after a while (the browser has long since read their final state). */
    sweep() {
        const now = Date.now();
        for (const [id, rec] of this.runs) if (rec.finished_at && now - rec.finished_at > KEEP_FINISHED_MS) this.runs.delete(id);
    }

    /** After a server restart: bring back runs saved by an earlier process, with the loss/profit already realised carried over. */
    async resumeAll() {
        if (!this.enabled() || !persistenceEnabled()) return 0;
        let resumed = 0;
        try {
            const pool = getPool();
            await ensureTable(pool);
            const { rows } = await pool.query('SELECT loginid, payload FROM ai_runner_sessions');
            for (const row of rows) {
                try {
                    const s = decrypt(row.payload);
                    const remaining_loss = s.config.stop_loss + s.carried_profit;
                    const remaining_profit = s.config.take_profit - s.carried_profit;
                    if (remaining_loss <= 0 || remaining_profit <= 0 || validateConfig({ ...s.config, stop_loss: remaining_loss, take_profit: remaining_profit, stake: Math.min(s.config.stake, remaining_loss) })) {
                        await deleteSession(row.loginid); // its limit was already reached
                        continue;
                    }
                    await this._launch({ ...s, config: { ...s.config, stake: Math.min(s.config.stake, remaining_loss) }, tokens: s.tokens });
                    resumed += 1;
                } catch (err) {
                    console.error(`[runner] could not resume a saved run: ${err.message}`);
                }
            }
        } catch (err) {
            console.error('[runner] resume failed:', err.message);
        }
        return resumed;
    }
}
