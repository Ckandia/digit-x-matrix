// Runs entirely in the browser. Direct port of what used to be
// backend/src/strategyEngine.js — the trading logic itself didn't need to
// change at all, only where it runs, since it was already written against a
// small connection interface (send/subscribe/unsubscribe) rather than
// anything server-specific.
import { v4 as uuidv4 } from 'uuid';
import { DerivClientConnection } from './derivClient';
import { tradeBus } from './tradeBus';
import { TStrategyConfig, TStrategyStatus } from './types';

const TRADE_COOLDOWN_MS = 1000;
const FAST_TRADE_COOLDOWN_MS = 250;

const NEEDS_BARRIER = new Set(['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER']);

// Auto Flip swaps between the two sides of a binary digit bet after a loss.
// Only defined for pairs that are genuinely opposite — Matches/Differs and
// Over/Under also depend on the predicted digit.
const FLIP_PAIR: Record<string, string> = { DIGITEVEN: 'DIGITODD', DIGITODD: 'DIGITEVEN' };

/**
 * Runs a single digit-contract strategy against a shared DerivClientConnection.
 * Places one contract at a time; on settlement, applies the configured money
 * management rule, checks stop conditions, then places the next one.
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
    current_contract_type: string;
    last_result: 'win' | 'loss' | undefined = undefined;
    last_payout: number | undefined = undefined;
    stop_reason: string | undefined = undefined;
    error: string | undefined = undefined;

    private _stopRequested = false;
    private _active_poc_sub: number | null = null;
    private _burst_subs: number[] = [];

    constructor(connection: DerivClientConnection, config: TStrategyConfig, currency?: string) {
        this.id = uuidv4();
        this.client_id = config.client_id;
        this.label = config.label || this.id;
        this.connection = connection;
        this.config = config;
        this.currency = currency || 'USD';
        this.current_stake = config.stake;
        this.current_contract_type = config.contract_type;
    }

    toJSON(): TStrategyStatus {
        return {
            id: this.id,
            client_id: this.client_id,
            label: this.label,
            symbol: this.config.symbol,
            contract_type: this.current_contract_type as TStrategyConfig['contract_type'],
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

        const parameters: Record<string, unknown> = {
            amount: stake,
            basis: 'stake',
            contract_type: this.current_contract_type,
            currency: this.currency,
            duration: Math.max(1, Number(this.config.duration_ticks) || 1),
            duration_unit: 't',
            underlying_symbol: this.config.symbol,
        };
        if (NEEDS_BARRIER.has(this.current_contract_type)) parameters.barrier = String(this.config.prediction);

        let ticks_seen = -1; // the first push is the current tick, not a new one
        this._burst_subs.push(
            this.connection.subscribe({ ticks: this.config.symbol }, data => {
                if (data?.tick) ticks_seen += 1;
            })
        );

        tradeBus.log('info', `${this.label}: burst of ${count} x ${this.current_contract_type} (${parameters.duration} tick(s), stake ${stake}) on ${this.config.symbol}`);
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
            // All n requests leave in the same instant; Promise.allSettled only waits for the replies.
            const replies = await Promise.allSettled(
                Array.from({ length: n }, () => this.connection.send({ buy: '1', price: stake, parameters }))
            );
            for (const r of replies) {
                const id = r.status === 'fulfilled' ? r.value?.buy?.contract_id : undefined;
                if (id) ids.push(String(id));
                else {
                    rejected += 1;
                    if (!first_error) first_error = r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'no contract id';
                }
            }
        }
        if (rejected > 0) {
            tradeBus.log('error', `${this.label}: ${rejected} buys rejected on ${this.config.symbol} for ${parameters.duration} tick(s): ${first_error}`);
        }
        if (ids.length === 0) {
            this.status = 'error';
            this.error = first_error || 'No buys were accepted';
            return;
        }

        const entry_ticks = new Set<string>();
        const exit_digits = new Set<string>();
        let open = ids.length;
        for (const contract_id of ids) {
            const sub = this.connection.subscribe({ proposal_open_contract: 1, contract_id }, (data, err) => {
                if (err) return;
                const contract = data?.proposal_open_contract;
                if (contract) tradeBus.contract(contract);
                if (!contract?.is_sold) return;
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
                tradeBus.log(
                    this.total_profit >= 0 ? 'success' : 'error',
                    `${this.label}: burst done. ${this.wins} won, ${this.losses} lost, net ${this.total_profit.toFixed(2)}. ` +
                        `Entry ticks: ${entry_ticks.size}, last digits: ${[...exit_digits].join(',')}` +
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
            tradeBus.log('info', `${this.label}: stopped (${stop_reason}), net ${this.total_profit.toFixed(2)}`);
            return;
        }

        const parameters: Record<string, unknown> = {
            amount: this.current_stake,
            basis: 'stake',
            contract_type: this.current_contract_type,
            currency: this.currency,
            duration: Math.max(1, Number(this.config.duration_ticks) || 1),
            duration_unit: 't',
            underlying_symbol: this.config.symbol,
        };
        if (NEEDS_BARRIER.has(this.current_contract_type)) {
            parameters.barrier = String(this.config.prediction);
        }

        const tried = Number(parameters.duration);
        tradeBus.log(
            'info',
            `${this.label}: buying ${this.current_contract_type} on ${this.config.symbol}, ${tried} tick(s), stake ${this.current_stake}` +
                (NEEDS_BARRIER.has(this.current_contract_type) ? `, prediction ${this.config.prediction}` : '')
        );
        try {
            const buy_response = await this.connection.send({
                buy: '1',
                price: this.current_stake,
                parameters,
            });
            const contract_id = buy_response?.buy?.contract_id;
            if (!contract_id) throw new Error('Buy did not return a contract id');
            this._watchContract(contract_id);
        } catch (err: any) {
            this.status = 'error';
            this.error = err?.message || 'Failed to place trade';
            tradeBus.log(
                'error',
                `${this.label}: ${this.current_contract_type} on ${this.config.symbol} for ${tried} tick(s) failed: ${this.error}`
            );
        }
    }

    private _watchContract(contract_id: string) {
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

                const profit = Number(contract.profit ?? 0);
                const won = profit > 0;
                tradeBus.log(won ? 'success' : 'error', `${this.label}: ${won ? 'won' : 'lost'} ${Math.abs(profit).toFixed(2)} on ${this.config.symbol}`);
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

    private _applyAutoFlip(won: boolean) {
        if (!this.config.auto_flip || won) return;
        const flipped = FLIP_PAIR[this.current_contract_type];
        if (flipped) this.current_contract_type = flipped;
    }
}
