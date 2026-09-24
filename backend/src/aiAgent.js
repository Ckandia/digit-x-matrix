import { v4 as uuidv4 } from 'uuid';
import { DIGIT_SYMBOLS } from './marketFeed.js';

// ---------------------------------------------------------------------------
// Hard server-side caps. These are ceilings/floors the client CANNOT loosen —
// a client-supplied config can only make its own numbers stricter than these,
// never looser. This is what makes the "confidence gate" a real gate instead
// of a UI label: even a malicious or buggy frontend request can't bypass it,
// because the check happens here, not in the browser.
// ---------------------------------------------------------------------------
const HARD_MAX_STAKE = Number(process.env.AI_AGENT_MAX_STAKE || 25);
const HARD_MAX_TRADES_CEILING = Number(process.env.AI_AGENT_MAX_TRADES_CEILING || 200);
const HARD_MIN_CONFIDENCE_FLOOR = 40; // signals below this are statistical noise, never auto-tradable
const DEFAULT_MAX_TRADES = 50;
const GLOBAL_COOLDOWN_MS = 2000; // minimum gap between any two agent-placed trades, any symbol
const SYMBOL_COOLDOWN_MS = 6000; // minimum gap between two trades on the same symbol
const SCAN_INTERVAL_MS = 1000; // how often the agent re-scans live signals
const NEEDS_BARRIER = new Set(['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER']);
const ALL_SYMBOLS = DIGIT_SYMBOLS.map(s => s.symbol);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Validates and clamps a client-supplied AI agent config against the hard
 * caps above. Throws on anything that can't be made safe (missing stop loss,
 * for example — the agent refuses to run without one).
 */
export function buildAgentConfig(raw = {}) {
    const stake = Number(raw.stake);
    if (!Number.isFinite(stake) || stake < 0.35) {
        throw new Error('AI agent stake must be at least 0.35');
    }
    if (raw.stop_loss === undefined || raw.stop_loss === null || Number(raw.stop_loss) <= 0) {
        // Unlike a manual bulk-trader strategy, the agent runs unattended and
        // picks its own contracts — it must never run without a hard exit.
        throw new Error('A stop loss greater than 0 is required to run the AI agent');
    }

    const symbols =
        Array.isArray(raw.symbols) && raw.symbols.length
            ? raw.symbols.filter(s => ALL_SYMBOLS.includes(s))
            : ALL_SYMBOLS;
    if (symbols.length === 0) {
        throw new Error('No valid symbols selected for the AI agent');
    }

    return {
        symbols,
        stake: clamp(stake, 0.35, HARD_MAX_STAKE),
        // The client can only raise this gate, never lower it below the floor.
        min_confidence: clamp(Number(raw.min_confidence) || 65, HARD_MIN_CONFIDENCE_FLOOR, 100),
        stop_loss: Math.abs(Number(raw.stop_loss)),
        take_profit: raw.take_profit != null ? Math.abs(Number(raw.take_profit)) : null,
        max_trades: clamp(Number(raw.max_trades) || DEFAULT_MAX_TRADES, 1, HARD_MAX_TRADES_CEILING),
        duration_ticks: clamp(Number(raw.duration_ticks) || 1, 1, 10),
    };
}

/**
 * Scans every allowed symbol's current top signal and applies the confidence
 * gate. Returns the single best gate-passing candidate, or null. Every
 * candidate considered (passed or not) is reported via onCandidate so the
 * frontend pipeline view reflects what the agent is actually doing, not a
 * simulation of it.
 */
function pickCandidate(marketFeed, config, cooldowns, onCandidate) {
    const now = Date.now();
    if (now - (cooldowns.global || 0) < GLOBAL_COOLDOWN_MS) return null;

    let best = null;
    for (const symbol of config.symbols) {
        const snapshot = marketFeed.getSnapshot(symbol);
        const top = snapshot?.signals?.[0];
        if (!top) continue;

        const on_symbol_cooldown = now - (cooldowns.bySymbol.get(symbol) || 0) < SYMBOL_COOLDOWN_MS;
        const passes_gate = top.confidence >= config.min_confidence && !on_symbol_cooldown;

        onCandidate({
            phase: passes_gate ? 'gate_passed' : 'gate_rejected',
            symbol,
            contract_type: top.contract_type,
            label: top.label,
            confidence: top.confidence,
            basis: top.basis,
            reason: on_symbol_cooldown ? 'symbol cooldown' : passes_gate ? null : 'below confidence threshold',
        });

        if (passes_gate && (!best || top.confidence > best.confidence)) {
            best = { symbol, ...top };
        }
    }
    return best;
}

/**
 * Runs one AI-managed trading loop against an already-authenticated
 * DerivConnection. Structurally similar to StrategyEngine, but the contract
 * to trade is chosen live from marketFeed signals each cycle instead of being
 * fixed up front, and every decision — including rejections — is reported.
 */
export class AiAgent {
    constructor({ connection, marketFeed, config, currency, onEvent }) {
        this.id = uuidv4();
        this.connection = connection;
        this.marketFeed = marketFeed;
        this.config = config; // already validated by buildAgentConfig
        this.currency = currency || 'USD';
        this.onEvent = onEvent || (() => {});

        this.status = 'idle';
        this.trades = 0;
        this.wins = 0;
        this.losses = 0;
        this.total_profit = 0;
        this.stop_reason = undefined;
        this.error = undefined;

        this._cooldowns = { global: 0, bySymbol: new Map() };
        this._scanTimer = null;
        this._active_poc_sub = null;
        this._busy = false; // true while a trade is open — the agent never overlaps trades
        this._stopRequested = false;
    }

    toJSON() {
        return {
            id: this.id,
            status: this.status,
            symbols: this.config.symbols,
            min_confidence: this.config.min_confidence,
            stake: this.config.stake,
            trades: this.trades,
            wins: this.wins,
            losses: this.losses,
            total_profit: Number(this.total_profit.toFixed(2)),
            stop_reason: this.stop_reason,
            error: this.error,
        };
    }

    _emit(event) {
        this.onEvent({ agent_id: this.id, ts: Date.now(), ...event });
    }

    start() {
        this.status = 'running';
        this._emit({ phase: 'started', symbols: this.config.symbols, min_confidence: this.config.min_confidence });
        this._scanTimer = setInterval(() => this._scan(), SCAN_INTERVAL_MS);
    }

    stop(reason = 'stopped by user') {
        this._stopRequested = true;
        if (this._scanTimer) clearInterval(this._scanTimer);
        if (this.status === 'running') {
            this.status = 'stopped';
            this.stop_reason = reason;
        }
        if (this._active_poc_sub != null) {
            this.connection.unsubscribe(this._active_poc_sub);
            this._active_poc_sub = null;
        }
        this._emit({ phase: 'stopped', reason });
    }

    _checkStopConditions() {
        if (this.total_profit <= -this.config.stop_loss) return 'stop loss reached';
        if (this.config.take_profit != null && this.total_profit >= this.config.take_profit) {
            return 'take profit reached';
        }
        if (this.trades >= this.config.max_trades) return 'max trades reached';
        return null;
    }

    _scan() {
        if (this._stopRequested || this._busy || this.status !== 'running') return;

        const stop_reason = this._checkStopConditions();
        if (stop_reason) {
            this.stop(stop_reason);
            return;
        }

        const candidate = pickCandidate(this.marketFeed, this.config, this._cooldowns, c => this._emit(c));
        if (!candidate) return;

        this._executeCandidate(candidate);
    }

    async _executeCandidate(candidate) {
        this._busy = true;
        this._cooldowns.global = Date.now();
        this._cooldowns.bySymbol.set(candidate.symbol, Date.now());

        this._emit({
            phase: 'executing',
            symbol: candidate.symbol,
            contract_type: candidate.contract_type,
            confidence: candidate.confidence,
            stake: this.config.stake,
        });

        const parameters = {
            amount: this.config.stake,
            basis: 'stake',
            contract_type: candidate.contract_type,
            currency: this.currency,
            duration: this.config.duration_ticks,
            duration_unit: 't',
            symbol: candidate.symbol,
        };
        if (NEEDS_BARRIER.has(candidate.contract_type)) {
            parameters.barrier = String(candidate.prediction);
        }

        try {
            const buy_response = await this.connection.send({ buy: 1, price: this.config.stake, parameters });
            const contract_id = buy_response?.buy?.contract_id;
            if (!contract_id) throw new Error('Buy did not return a contract id');
            this._watchContract(candidate, contract_id);
        } catch (err) {
            this._busy = false;
            this.status = 'error';
            this.error = err.message || 'Failed to place AI-selected trade';
            this._emit({ phase: 'error', symbol: candidate.symbol, error: this.error });
        }
    }

    _watchContract(candidate, contract_id) {
        this._active_poc_sub = this.connection.subscribe({ proposal_open_contract: 1, contract_id }, (data, err) => {
            if (err) {
                this._busy = false;
                this.status = 'error';
                this.error = err.message;
                this._emit({ phase: 'error', symbol: candidate.symbol, error: this.error });
                return;
            }
            const contract = data?.proposal_open_contract;
            if (!contract?.is_sold) return;

            this.connection.unsubscribe(this._active_poc_sub);
            this._active_poc_sub = null;

            const profit = Number(contract.profit ?? 0);
            const won = profit > 0;
            this.trades += 1;
            this.total_profit += profit;
            if (won) this.wins += 1;
            else this.losses += 1;

            this._emit({
                phase: 'settled',
                symbol: candidate.symbol,
                contract_type: candidate.contract_type,
                result: won ? 'win' : 'loss',
                profit: Number(profit.toFixed(2)),
                total_profit: Number(this.total_profit.toFixed(2)),
                trades: this.trades,
            });

            this._busy = false;
        });
    }
}
