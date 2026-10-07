// Runs entirely in the browser. This replaces what used to be a REST call to
// our own backend (POST /api/bulk/start, holding the user's token server-side
// and trading with it). Now a "run" is just an in-memory object in this tab:
// one DerivClientConnection, opened with the token the user pasted into the
// header, shared by every StrategyEngine in the run. Nothing here is sent
// over the network to anything except Deriv itself.
import { tradeBus } from './tradeBus';
import { v4 as uuidv4 } from 'uuid';
import { DerivClientConnection } from './derivClient';
import { StrategyEngine } from './strategyEngineClient';
import { TRunStatus, TStartBulkRunResponse, TStrategyConfig } from './types';

const MAX_STRATEGIES_PER_RUN = 5;

type TRun = {
    connection: DerivClientConnection;
    engines: Map<string, StrategyEngine>;
    loginid: string;
    started_at: string;
};

const runs = new Map<string, TRun>();

const validateStrategyConfig = (config: TStrategyConfig) => {
    const required: (keyof TStrategyConfig)[] = ['symbol', 'contract_type', 'stake', 'money_management'];
    for (const key of required) {
        if (config[key] === undefined || config[key] === null || (config[key] as unknown) === '') {
            throw new Error(`Strategy "${config.label || config.client_id}" is missing "${key}"`);
        }
    }
    if (config.stake < 0.35) {
        throw new Error(`Strategy "${config.label}" stake must be at least 0.35`);
    }
    if (config.burst_count !== undefined && (config.burst_count < 1 || config.burst_count > 50)) {
        throw new Error(`Strategy "${config.label}" burst size must be between 1 and 50`);
    }
    const needs_prediction = ['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(config.contract_type);
    if (needs_prediction && (config.prediction === undefined || config.prediction < 0 || config.prediction > 9)) {
        throw new Error(`Strategy "${config.label}" needs a digit prediction between 0 and 9`);
    }
};

export const startBulkRun = async (
    token: string,
    strategy_configs: TStrategyConfig[]
): Promise<TStartBulkRunResponse> => {
    if (!token) throw new Error('No active session token found.');
    if (!Array.isArray(strategy_configs) || strategy_configs.length === 0) {
        throw new Error('At least one strategy is required');
    }
    if (strategy_configs.length > MAX_STRATEGIES_PER_RUN) {
        throw new Error(`A maximum of ${MAX_STRATEGIES_PER_RUN} strategies can run at once`);
    }

    const connection = new DerivClientConnection(token);
    const auth = await connection.connect();
    const loginid = auth?.authorize?.loginid;
    const currency = auth?.authorize?.currency;
    if (!loginid) {
        connection.close();
        throw new Error('Could not authorize with the provided token');
    }

    const run_id = uuidv4();
    const engines = new Map<string, StrategyEngine>();

    for (const config of strategy_configs) {
        validateStrategyConfig(config);
        const engine = new StrategyEngine(connection, config, currency);
        engines.set(engine.id, engine);
    }

    connection.onReconnecting = () => tradeBus.log('info', 'Connection to Deriv dropped; reconnecting...');
    connection.onReconnect = () => tradeBus.log('success', 'Reconnected to Deriv. Open contracts are being re-checked.');
    connection.onFatalError = () => {
        tradeBus.log('error', 'Lost connection to Deriv and could not reconnect.');
        for (const engine of engines.values()) {
            if (engine.status === 'running') {
                engine.status = 'error';
                engine.error = 'Lost connection to Deriv';
            }
        }
    };

    runs.set(run_id, { connection, engines, loginid, started_at: new Date().toISOString() });

    for (const engine of engines.values()) {
        engine.start();
    }

    return {
        run_id,
        strategies: Array.from(engines.values()).map(e => ({ client_id: e.client_id, id: e.id })),
    };
};

export const getBulkRunStatus = async (run_id: string): Promise<TRunStatus> => {
    const run = runs.get(run_id);
    if (!run) throw new Error('Run not found');
    const strategies = Array.from(run.engines.values()).map(e => e.toJSON());
    const is_active = strategies.some(s => s.status === 'running');
    if (!is_active) closeRunIfIdle(run_id);
    return {
        run_id,
        loginid: run.loginid,
        started_at: run.started_at,
        strategies,
        is_active,
    };
};

export const stopBulkRun = async (run_id: string, strategy_id?: string): Promise<{ ok: boolean }> => {
    const run = runs.get(run_id);
    if (!run) throw new Error('Run not found');

    if (strategy_id) {
        const engine = run.engines.get(strategy_id);
        if (!engine) throw new Error('Strategy not found');
        engine.stop('stopped by user');
    } else {
        for (const engine of run.engines.values()) {
            engine.stop('stopped by user');
        }
    }

    const still_running = Array.from(run.engines.values()).some(e => e.status === 'running');
    if (!still_running) closeRunIfIdle(run_id);
    return { ok: true };
};

const closeRunIfIdle = (run_id: string) => {
    const run = runs.get(run_id);
    if (!run) return;
    const still_running = Array.from(run.engines.values()).some(e => e.status === 'running');
    if (still_running) return;
    run.connection.close();
    runs.delete(run_id);
};
