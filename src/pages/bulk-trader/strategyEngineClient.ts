// Runs entirely in the browser. Direct port of what used to be
// backend/src/strategyEngine.js — the trading logic itself didn't need to
// change at all, only where it runs, since it was already written against a
// small connection interface (send/subscribe/unsubscribe) rather than
// anything server-specific.
import { v4 as uuidv4 } from 'uuid';
import type { DerivClientConnection } from './derivClient';
import {
    MULTIPLIER_TAKE_PROFIT_PCT,
    nextAfterLoss,
    pickMultiplier,
    relativeBarrier,
    specOf,
    tickCandidates,
    TBulkSpec,
} from './contractSpecs';
import { tradeBus } from './tradeBus';
import { TickTrendMonitor, trendLabel } from './trendFilter';
import { TBulkContractType, TStrategyConfig, TStrategyStatus } from './types';

const TRADE_COOLDOWN_MS = 1000;
const FAST_TRADE_COOLDOWN_MS = 250;
const DEFAULT_MULTIPLIER = 100;

// Deriv's wording when a duration / barrier is not offered for a market. Only then is the next
// duration in the list (Touch / No Touch: 5 ticks, then 10) tried; any other error stops the strategy.
// "This contract offers no return" = the barrier is so far (No Touch) or so near (Touch) that the payout would not beat the stake;
// a longer duration widens the odds, so 5 -> 10 ticks is tried for that too.
const DURATION_ERROR = /duration|barrier|offered|tick|no return/i;

const round2 = (n: number) => Number(n.toFixed(2));

/**
 * Runs a single contract strategy (digits, Rise/Fall, Higher/Lower, Touch/No Touch, Multipliers)
 * against a shared DerivClientConnection. Places one contract at a time; on settlement, applies the
 * configured money management rule, checks stop conditions, then places the next one.
 * Trend contracts (Rise/Fall, Higher/Lower, Multipliers) are only bought once the 1-tick chart shows
 * a higher high (bullish) or a lower low (bearish).
 */
export class StrategyEngine {
    id: string;
    client_id: string;
    label: string;
    connection: DerivClientConnection;
    config: TStrategyConfig;
    currency: string;

    status: 'idle' | 'running' | 'stopped' | 'error' = 'idle';
    trades = 0;
    wins = 0;
    losses = 0;
    total_profit = 0;
    current_stake: number;
    current_contract_type: TBulkContractType;
    /** The contract the strategy was started with; Auto Flip switches between this and its partner. */
    original_contract_type: TBulkContractType;
    last_result: 'win' | 'loss' | undefined = undefined;
    last_payout: number | undefined = undefined;
    stop_reason: string | undefined = undefined;
    error: string | undefined = undefined;

    private _stopRequested = false;
    private _active_poc_sub: number | null = null;
    private _burst_subs: number[] = [];
    private _monitor: TickTrendMonitor | null = null;
    private _open_multipliers = new Set<string>();
    private _ticks_override: Partial<Record<TBulkContractType, number>> = {};
    private _auto_multiplier: number | null = null;

    constructor(connection: DerivClientConnection, config: TStrategyConfig, currency?: string) {
        this.id = uuidv4();
        this.client_id = config.client_id;
        this.label = config.label || this.id;
        this.connection = connection;
        this.config = config;
        this.currency = currency || 'USD';
        this.current_stake = config.stake;
        this.current_contract_type = config.contract_type;
        this.original_contract_type = config.contract_type;
    }

    toJSON(): TStrategyStatus {
        return {
            id: this.id,
            client_id: this.client_id,
            label: this.label,
            symbol: this.config.symbol,
            contract_type: this.current_contract_type,
            status: this.status,
            trades: this.trades,
            wins: this.wins,
            losses: this.losses,
            total_profit: Number(this.total_profit.toFixed(2)),
            current_stake: Number(this.current_stake.toFixed(2)),
            last_result: this.last_result,
            last_payout: this.last_payout,
            stop_reason: this.stop_reason,
            error: this.error,
        };
    }

    start() {
        this.status = 'running';
        tradeBus.log('info', `${this.label}: started on ${this.config.symbol}`);
        if ((this.config.burst_count ?? 1) > 1) {
            void this._runBurst();
            return;
        }
        this._placeNextTrade();
    }

    stop(reason = 'stopped by user') {
        this._stopRequested = true;
        if (this.status === 'running') {
            this.status = 'stopped';
            this.stop_reason = reason;
            tradeBus.log('info', `${this.label}: stopped (${reason})`);
        }
        if (this._active_poc_sub != null) {
            this.connection.unsubscribe(this._active_poc_sub);
            this._active_poc_sub = null;
        }
        for (const sub of this._burst_subs) this.connection.unsubscribe(sub);
        this._burst_subs = [];
        this._monitor?.stop();
        this._monitor = null;
        this._sellOpenMultipliers();
    }

    /** A multiplier has no expiry, so stopping the strategy must close the ones still open. */
    private _sellOpenMultipliers() {
        for (const contract_id of this._open_multipliers) {
            tradeBus.log('info', `${this.label}: closing open multiplier ${contract_id}`);
            this.connection
                .send({ sell: contract_id, price: 0 })
                .catch((err: Error) =>
                    tradeBus.log('error', `${this.label}: could not close multiplier ${contract_id}: ${err.message}`)
                );
        }
        this._open_multipliers.clear();
    }

    /** Waits (without trading) until the 1-tick chart confirms the trend this contract needs. */
    private async _confirmTrend(spec: TBulkSpec): Promise<boolean> {
        if (!spec.trend) return true;
        if (!this._monitor) {
            this._monitor = new TickTrendMonitor(this.connection, this.config.symbol);
            await this._monitor.start();
        }
        const monitor = this._monitor;
        if (this._stopRequested || !monitor) return false;
        const already = monitor.trend() === spec.trend;
        if (!already) {
            tradeBus.log('info', `${this.label}: waiting for a ${trendLabel(spec.trend)} on the 1-tick chart before ${spec.label}`);
        }
        const ok = await monitor.waitFor(spec.trend);
        if (ok && !already) tradeBus.log('info', `${this.label}: ${trendLabel(spec.trend)} confirmed, placing ${spec.label}`);
        return ok && !this._stopRequested;
    }

    /** Ticks to try for this contract, starting from the one that last worked. */
    private _ticksToTry(spec: TBulkSpec): (number | undefined)[] {
        const all = tickCandidates(spec, this.config.duration_ticks);
        if (all.length === 0) return [undefined];
        const preferred = this._ticks_override[spec.key];
        return preferred !== undefined && all.includes(preferred) ? all.slice(all.indexOf(preferred)) : all;
    }

    private async _multiplierValue(): Promise<number> {
        if (this.config.mult_value && this.config.mult_value > 0) return Math.floor(this.config.mult_value);
        if (this._auto_multiplier) return this._auto_multiplier;
        let chosen = DEFAULT_MULTIPLIER;
        try {
            const reply = await this.connection.send({ contracts_for: this.config.symbol, currency: this.currency });
            const picked = pickMultiplier(reply);
            if (picked) chosen = picked;
            else tradeBus.log('info', `${this.label}: no multiplier list from Deriv, using ${chosen}x`);
        } catch {
            tradeBus.log('info', `${this.label}: could not read the multiplier list, using ${chosen}x`);
        }
        this._auto_multiplier = chosen;
        return chosen;
    }

    /** The buy parameters for one contract of this spec. */
    private async _parameters(spec: TBulkSpec, stake: number, ticks: number | undefined): Promise<Record<string, unknown>> {
        const parameters: Record<string, unknown> = {
            amount: stake,
            basis: 'stake',
            contract_type: spec.api_type,
            currency: this.currency,
            underlying_symbol: this.config.symbol,
        };
        if (spec.family === 'multiplier') {
            parameters.multiplier = await this._multiplierValue();
            // Closes by itself once the profit reaches 20% of the stake.
            parameters.limit_order = { take_profit: round2(stake * MULTIPLIER_TAKE_PROFIT_PCT) };
            return parameters;
        }
        parameters.duration = ticks ?? 1;
        parameters.duration_unit = 't';
        if (spec.barrier_digit !== undefined) parameters.barrier = String(spec.barrier_digit);
        else if (spec.needs_prediction) parameters.barrier = String(this.config.prediction);
        else if (spec.family === 'higher_lower' || spec.family === 'touch') {
            parameters.barrier = relativeBarrier(spec, this.config.barrier_offset);
        }
        return parameters;
    }

    private _describe(spec: TBulkSpec, parameters: Record<string, unknown>) {
        if (spec.family === 'multiplier') return `${parameters.multiplier}x, closes at +20% of stake`;
        return `${parameters.duration} tick(s)` + (parameters.barrier !== undefined ? `, barrier ${parameters.barrier}` : '');
    }

    /**
     * Burst mode: fire all the buys together, on the tick when Start is pressed, instead of one
     * trade after another. Buys go out in concurrent chunks of 10; before each later chunk the
     * tick counter is checked, and if more than `max_entry_ticks` ticks have already passed the
     * remaining buys are NOT sent (slippage cap). So every contract enters within at most that
     * many ticks, and for tick contracts the results carry at most that many different last digits.
     */
    private async _runBurst() {
        const CHUNK = 10;
        const cap = Math.max(1, Math.min(5, Math.floor(this.config.max_entry_ticks ?? 3)));
        const stake = this.config.stake;
        const spec = specOf(this.current_contract_type);
        let count = Math.floor(this.config.burst_count ?? 1);
        const balance = this.connection.accountInfo?.balance;
        if (typeof balance === 'number' && stake * count > balance) {
            const affordable = Math.floor(balance / stake);
            tradeBus.log('error', `${this.label}: balance ${balance} cannot cover ${count} x ${stake}; sending ${affordable} instead`);
            count = affordable;
        }
        if (count < 1) {
            this.status = 'error';
            this.error = 'Balance is too small for even one trade at this stake';
            return;
        }

        // Trend contracts wait for the 1-tick chart to confirm the trend before the whole burst goes out.
        if (!(await this._confirmTrend(spec))) return;

        const attempts = this._ticksToTry(spec);
        let attempt = 0;
        let parameters = await this._parameters(spec, stake, attempts[attempt]);

        let ticks_seen = -1; // the first push is the current tick, not a new one
        this._burst_subs.push(
            this.connection.subscribe({ ticks: this.config.symbol }, data => {
                if (data?.tick) ticks_seen += 1;
            })
        );

        tradeBus.log(
            'info',
            `${this.label}: burst of ${count} x ${spec.label} (${this._describe(spec, parameters)}, stake ${stake}) on ${this.config.symbol}`
        );
        const sendChunk = async (n: number) => {
            // All n requests leave in the same instant; Promise.allSettled only waits for the replies.
            const replies = await Promise.allSettled(
                Array.from({ length: n }, () => this.connection.send({ buy: '1', price: stake, parameters }))
            );
            const got: string[] = [];
            let bad = 0;
            let err = '';
            for (const r of replies) {
                const id = r.status === 'fulfilled' ? r.value?.buy?.contract_id : undefined;
                if (id) got.push(String(id));
                else {
                    bad += 1;
                    if (!err) err = r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'no contract id';
                }
            }
            return { got, bad, err };
        };

        const ids: string[] = [];
        let rejected = 0;
        let first_error = '';
        let skipped = 0;
        for (let sent = 0; sent < count && !this._stopRequested; sent += CHUNK) {
            if (sent > 0 && ticks_seen >= cap) {
                skipped = count - sent;
                tradeBus.log('error', `${this.label}: slippage cap reached (${cap} ticks); ${skipped} buys were not sent`);
                break;
            }
            const n = Math.min(CHUNK, count - sent);
            let r = await sendChunk(n);
            // Nothing accepted and Deriv objects to the duration/barrier: try the next duration (Touch: 5 -> 10 ticks).
            if (sent === 0 && r.got.length === 0 && attempt < attempts.length - 1 && DURATION_ERROR.test(r.err)) {
                attempt += 1;
                tradeBus.log('info', `${this.label}: ${spec.label} refused (${r.err}); trying ${attempts[attempt]} ticks`);
                parameters = await this._parameters(spec, stake, attempts[attempt]);
                r = await sendChunk(n);
                if (r.got.length > 0) this._ticks_override[spec.key] = attempts[attempt] as number;
            }
            ids.push(...r.got);
            rejected += r.bad;
            if (!first_error) first_error = r.err;
        }
        if (rejected > 0) {
            tradeBus.log('error', `${this.label}: ${rejected} buys rejected on ${this.config.symbol} (${this._describe(spec, parameters)}): ${first_error}`);
        }
        if (ids.length === 0) {
            this.status = 'error';
            this.error = first_error || 'No buys were accepted';
            return;
        }
        if (spec.family === 'multiplier') ids.forEach(id => this._open_multipliers.add(id));

        const entry_ticks = new Set<string>();
        const exit_digits = new Set<string>();
        let open = ids.length;
        for (const contract_id of ids) {
            const sub = this.connection.subscribe({ proposal_open_contract: 1, contract_id }, (data, err) => {
                if (err) return;
                const contract = data?.proposal_open_contract;
                if (contract) tradeBus.contract(contract);
                if (!contract?.is_sold) return;
                this._open_multipliers.delete(contract_id);
                const profit = Number(contract.profit ?? 0);
                this.trades += 1;
                this.total_profit += profit;
                if (profit > 0) this.wins += 1;
                else this.losses += 1;
                this.last_result = profit > 0 ? 'win' : 'loss';
                entry_ticks.add(String(contract.entry_tick_time ?? contract.date_start ?? ''));
                exit_digits.add(String(contract.exit_tick_display_value ?? contract.exit_tick ?? '').slice(-1));
                open -= 1;
                if (open > 0) return;
                this.status = 'stopped';
                this.stop_reason = 'burst complete';
                this._monitor?.stop();
                this._monitor = null;
                tradeBus.log(
                    this.total_profit >= 0 ? 'success' : 'error',
                    `${this.label}: burst done. ${this.wins} won, ${this.losses} lost, net ${this.total_profit.toFixed(2)}. ` +
                        (spec.family === 'digit'
                            ? `Entry ticks: ${entry_ticks.size}, last digits: ${[...exit_digits].join(',')}`
                            : `Entry ticks: ${entry_ticks.size}`) +
                        (skipped ? `, ${skipped} not sent (slippage cap)` : '')
                );
                for (const s of this._burst_subs) this.connection.unsubscribe(s);
                this._burst_subs = [];
            });
            this._burst_subs.push(sub);
        }
    }

    private _checkStopConditions(): string | null {
        const { take_profit, stop_loss, max_trades } = this.config;
        if (typeof take_profit === 'number' && this.total_profit >= take_profit) {
            return 'take profit reached';
        }
        if (typeof stop_loss === 'number' && this.total_profit <= -Math.abs(stop_loss)) {
            return 'stop loss reached';
        }
        if (typeof max_trades === 'number' && this.trades >= max_trades) {
            return 'max trades reached';
        }
        return null;
    }

    private _applyMoneyManagement(won: boolean) {
        const { money_management, multiplier, stake: base_stake } = this.config;
        if (money_management === 'martingale') {
            this.current_stake = won ? base_stake : Number((this.current_stake * (multiplier || 2)).toFixed(2));
        } else if (money_management === 'dalembert') {
            const unit = base_stake * ((multiplier || 2) - 1);
            this.current_stake = won
                ? Math.max(base_stake, Number((this.current_stake - unit).toFixed(2)))
                : Number((this.current_stake + unit).toFixed(2));
        }
        // 'flat' — stake never changes.
    }

    private async _placeNextTrade() {
        if (this._stopRequested) return;

        const stop_reason = this._checkStopConditions();
        if (stop_reason) {
            this.status = 'stopped';
            this.stop_reason = stop_reason;
            this._monitor?.stop();
            this._monitor = null;
            tradeBus.log('info', `${this.label}: stopped (${stop_reason}), net ${this.total_profit.toFixed(2)}`);
            return;
        }

        const spec = specOf(this.current_contract_type);

        // Trend contracts (Rise/Fall, Higher/Lower, Multipliers): no buy until the 1-tick chart confirms the trend.
        if (!(await this._confirmTrend(spec))) return;

        const attempts = this._ticksToTry(spec);
        let last_error = '';
        let tried: number | undefined;
        for (let i = 0; i < attempts.length; i++) {
            if (this._stopRequested) return;
            tried = attempts[i];
            try {
                const parameters = await this._parameters(spec, this.current_stake, tried);
                tradeBus.log(
                    'info',
                    `${this.label}: buying ${spec.label} on ${this.config.symbol}, ${this._describe(spec, parameters)}, stake ${this.current_stake}` +
                        (spec.needs_prediction ? `, prediction ${this.config.prediction}` : '')
                );
                const buy_response = await this.connection.send({
                    buy: '1',
                    price: this.current_stake,
                    parameters,
                });
                const contract_id = buy_response?.buy?.contract_id;
                if (!contract_id) throw new Error('Buy did not return a contract id');
                if (tried !== undefined && attempts.length > 1) this._ticks_override[spec.key] = tried;
                this._watchContract(String(contract_id), spec);
                return;
            } catch (err: any) {
                last_error = err?.message || 'Failed to place trade';
                const has_next = i < attempts.length - 1;
                if (!(has_next && DURATION_ERROR.test(last_error))) break;
                tradeBus.log('info', `${this.label}: ${spec.label} refused at ${tried} ticks (${last_error}); trying ${attempts[i + 1]} ticks`);
            }
        }
        this.status = 'error';
        this.error = last_error;
        this._monitor?.stop();
        this._monitor = null;
        tradeBus.log(
            'error',
            `${this.label}: ${spec.label} on ${this.config.symbol}${tried !== undefined ? ` for ${tried} tick(s)` : ''} failed: ${this.error}`
        );
    }

    private _watchContract(contract_id: string, spec: TBulkSpec) {
        if (spec.family === 'multiplier') this._open_multipliers.add(contract_id);
        this._active_poc_sub = this.connection.subscribe(
            { proposal_open_contract: 1, contract_id },
            (data, err) => {
                if (err) {
                    this.status = 'error';
                    this.error = err.message;
                    tradeBus.log('error', `${this.label}: lost track of contract ${contract_id}: ${err.message}`);
                    return;
                }
                const contract = data?.proposal_open_contract;
                if (contract) tradeBus.contract(contract);
                if (!contract?.is_sold) return; // still open — wait for settlement

                if (this._active_poc_sub != null) this.connection.unsubscribe(this._active_poc_sub);
                this._active_poc_sub = null;
                this._open_multipliers.delete(contract_id);

                const profit = Number(contract.profit ?? 0);
                const won = profit > 0;
                tradeBus.log(won ? 'success' : 'error', `${this.label}: ${spec.label} ${won ? 'won' : 'lost'} ${Math.abs(profit).toFixed(2)} on ${this.config.symbol}`);
                this.trades += 1;
                this.total_profit += profit;
                this.last_result = won ? 'win' : 'loss';
                this.last_payout = Number(profit.toFixed(2));
                if (won) this.wins += 1;
                else this.losses += 1;

                this._applyMoneyManagement(won);
                this._applyAutoFlip(won);

                if (this._stopRequested) return;
                const cooldown = this.config.fast_execution ? FAST_TRADE_COOLDOWN_MS : TRADE_COOLDOWN_MS;
                setTimeout(() => this._placeNextTrade(), cooldown);
            }
        );
    }

    /** After a loss: switch to the partner contract; after the next loss, back to the original. */
    private _applyAutoFlip(won: boolean) {
        if (!this.config.auto_flip || won) return;
        const next = nextAfterLoss(this.original_contract_type, this.current_contract_type);
        if (next !== this.current_contract_type) {
            tradeBus.log('info', `${this.label}: loss, switching ${specOf(this.current_contract_type).label} -> ${specOf(next).label}`);
            this.current_contract_type = next;
        }
    }
}
