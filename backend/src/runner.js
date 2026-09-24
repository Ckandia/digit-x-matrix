import { v4 as uuidv4 } from 'uuid';
import { DerivConnection } from './derivConnection.js';
import { StrategyEngine } from './strategyEngine.js';
import { AiAgent, buildAgentConfig } from './aiAgent.js';
import { logRunStart, logRunEnd } from './db.js';

const MAX_STRATEGIES_PER_RUN = 5;

/** run_id -> { connection, engines: Map<engine_id, StrategyEngine>, loginid, started_at } */
const runs = new Map();

/** run_id -> { connection, agent: AiAgent, loginid, started_at } — kept separate
 *  from `runs` because an AI run has exactly one agent, not a set of engines,
 *  and it needs its own event stream instead of per-engine status polling. */
const ai_runs = new Map();

export const startBulkRun = async (token, strategy_configs) => {
    if (!Array.isArray(strategy_configs) || strategy_configs.length === 0) {
        throw new Error('At least one strategy is required');
    }
    if (strategy_configs.length > MAX_STRATEGIES_PER_RUN) {
        throw new Error(`A maximum of ${MAX_STRATEGIES_PER_RUN} strategies can run at once`);
    }

    const connection = new DerivConnection(token);
    const auth = await connection.connect();
    const loginid = auth?.authorize?.loginid;
    const currency = auth?.authorize?.currency;
    if (!loginid) {
        connection.close();
        throw new Error('Could not authorize with the provided token');
    }

    const run_id = uuidv4();
    const engines = new Map();

    for (const config of strategy_configs) {
        validateStrategyConfig(config);
        const engine = new StrategyEngine(connection, config, currency);
        engines.set(engine.id, engine);
    }

    connection.onFatalError = () => {
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

    logRunStart(run_id, loginid, strategy_configs);

    return {
        run_id,
        strategies: Array.from(engines.values()).map(e => ({ client_id: e.client_id, id: e.id })),
    };
};

const validateStrategyConfig = config => {
    const required = ['symbol', 'contract_type', 'stake', 'money_management'];
    for (const key of required) {
        if (config[key] === undefined || config[key] === null || config[key] === '') {
            throw new Error(`Strategy "${config.label || config.client_id}" is missing "${key}"`);
        }
    }
    if (config.stake < 0.35) {
        throw new Error(`Strategy "${config.label}" stake must be at least 0.35`);
    }
    const needs_prediction = ['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(config.contract_type);
    if (needs_prediction && (config.prediction === undefined || config.prediction < 0 || config.prediction > 9)) {
        throw new Error(`Strategy "${config.label}" needs a digit prediction between 0 and 9`);
    }
};

export const getRunStatus = run_id => {
    const run = runs.get(run_id);
    if (!run) return null;
    const strategies = Array.from(run.engines.values()).map(e => e.toJSON());
    const is_active = strategies.some(s => s.status === 'running');
    if (!is_active) {
        closeRunIfIdle(run_id);
    }
    return {
        run_id,
        loginid: run.loginid,
        started_at: run.started_at,
        strategies,
        is_active,
    };
};

export const stopStrategy = (run_id, strategy_id) => {
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
    if (!still_running) {
        closeRunIfIdle(run_id);
    }
    return true;
};

const closeRunIfIdle = run_id => {
    const run = runs.get(run_id);
    if (!run) return;
    const still_running = Array.from(run.engines.values()).some(e => e.status === 'running');
    if (still_running) return;
    run.connection.close();
    logRunEnd(run_id, Array.from(run.engines.values()).map(e => e.toJSON()));
    runs.delete(run_id);
};

// Safety net: sweep stale runs periodically in case a client never polls stop.
setInterval(() => {
    for (const run_id of runs.keys()) {
        getRunStatus(run_id);
    }
}, 60_000).unref?.();

// ---------------------------------------------------------------------------
// AI agent runs. Same authenticated-connection lifecycle as a bulk run, but
// with a single AiAgent instead of a set of fixed strategies, and an event
// stream (onEvent) instead of poll-only status, so the frontend pipeline view
// can react to real decisions in real time.
// ---------------------------------------------------------------------------

export const startAiRun = async (token, rawConfig, marketFeed, onEvent) => {
    const config = buildAgentConfig(rawConfig); // throws on anything unsafe — caller returns 400

    const connection = new DerivConnection(token);
    const auth = await connection.connect();
    const loginid = auth?.authorize?.loginid;
    const currency = auth?.authorize?.currency;
    if (!loginid) {
        connection.close();
        throw new Error('Could not authorize with the provided token');
    }

    const agent = new AiAgent({ connection, marketFeed, config, currency, onEvent });

    connection.onFatalError = () => {
        if (agent.status === 'running') {
            agent.status = 'error';
            agent.error = 'Lost connection to Deriv';
            agent._emit?.({ phase: 'error', error: agent.error });
        }
    };

    const run_id = uuidv4();
    ai_runs.set(run_id, { connection, agent, loginid, started_at: new Date().toISOString() });

    agent.start();
    logRunStart(run_id, loginid, [{ label: 'AI agent', ...config }]);

    return { run_id, agent_id: agent.id, loginid };
};

export const getAiRunStatus = run_id => {
    const run = ai_runs.get(run_id);
    if (!run) return null;
    const agent = run.agent.toJSON();
    if (agent.status !== 'running') closeAiRunIfIdle(run_id);
    return { run_id, loginid: run.loginid, started_at: run.started_at, agent };
};

export const stopAiRun = run_id => {
    const run = ai_runs.get(run_id);
    if (!run) throw new Error('AI run not found');
    run.agent.stop('stopped by user');
    closeAiRunIfIdle(run_id);
    return true;
};

const closeAiRunIfIdle = run_id => {
    const run = ai_runs.get(run_id);
    if (!run || run.agent.status === 'running') return;
    run.connection.close();
    logRunEnd(run_id, [run.agent.toJSON()]);
    ai_runs.delete(run_id);
};

setInterval(() => {
    for (const run_id of ai_runs.keys()) {
        getAiRunStatus(run_id);
    }
}, 60_000).unref?.();
