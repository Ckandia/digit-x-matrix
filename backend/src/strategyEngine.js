import { v4 as uuidv4 } from 'uuid';

const TRADE_COOLDOWN_MS = 1000;

const NEEDS_BARRIER = new Set(['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER']);

/**
 * Runs a single digit-contract strategy against a shared DerivConnection.
 * Places one contract at a time; on settlement, applies the configured money
 * management rule, checks stop conditions, then places the next one.
 */
export class StrategyEngine {
    constructor(connection, config, currency) {
        this.id = uuidv4();
        this.client_id = config.client_id;
        this.label = config.label || this.id;
        this.connection = connection;
        this.config = config;
        this.currency = currency || 'USD';

        this.status = 'idle';
        this.trades = 0;
        this.wins = 0;
        this.losses = 0;
        this.total_profit = 0;
        this.current_stake = config.stake;
        this.last_result = undefined;
        this.last_payout = undefined;
        this.stop_reason = undefined;
        this.error = undefined;

        this._stopRequested = false;
        this._active_poc_sub = null;
    }

    toJSON() {
        return {
            id: this.id,
            client_id: this.client_id,
            label: this.label,
            symbol: this.config.symbol,
            contract_type: this.config.contract_type,
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
        this._placeNextTrade();
    }

    stop(reason = 'stopped by user') {
        this._stopRequested = true;
        if (this.status === 'running') {
            this.status = 'stopped';
            this.stop_reason = reason;
        }
        if (this._active_poc_sub != null) {
            this.connection.unsubscribe(this._active_poc_sub);
            this._active_poc_sub = null;
        }
    }

    _checkStopConditions() {
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

    _applyMoneyManagement(won) {
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

    async _placeNextTrade() {
        if (this._stopRequested) return;

        const stop_reason = this._checkStopConditions();
        if (stop_reason) {
            this.status = 'stopped';
            this.stop_reason = stop_reason;
            return;
        }

        const parameters = {
            amount: this.current_stake,
            basis: 'stake',
            contract_type: this.config.contract_type,
            currency: this.currency,
            duration: 1,
            duration_unit: 't',
            symbol: this.config.symbol,
        };
        if (NEEDS_BARRIER.has(this.config.contract_type)) {
            parameters.barrier = String(this.config.prediction);
        }

        try {
            const buy_response = await this.connection.send({
                buy: 1,
                price: this.current_stake,
                parameters,
            });
            const contract_id = buy_response?.buy?.contract_id;
            if (!contract_id) throw new Error('Buy did not return a contract id');
            this._watchContract(contract_id);
        } catch (err) {
            this.status = 'error';
            this.error = err.message || 'Failed to place trade';
        }
    }

    _watchContract(contract_id) {
        this._active_poc_sub = this.connection.subscribe(
            { proposal_open_contract: 1, contract_id },
            (data, err) => {
                if (err) {
                    this.status = 'error';
                    this.error = err.message;
                    return;
                }
                const contract = data?.proposal_open_contract;
                if (!contract?.is_sold) return; // still open — wait for settlement

                this.connection.unsubscribe(this._active_poc_sub);
                this._active_poc_sub = null;

                const profit = Number(contract.profit ?? 0);
                const won = profit > 0;
                this.trades += 1;
                this.total_profit += profit;
                this.last_result = won ? 'win' : 'loss';
                this.last_payout = Number(profit.toFixed(2));
                if (won) this.wins += 1;
                else this.losses += 1;

                this._applyMoneyManagement(won);

                if (this._stopRequested) return;
                setTimeout(() => this._placeNextTrade(), TRADE_COOLDOWN_MS);
            }
        );
    }
}
