import pg from 'pg';

const { Pool } = pg;

let pool = null;
let ready = false;

const init = async () => {
    if (!process.env.DATABASE_URL) return;
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        // Neon (and most managed Postgres) requires TLS; rejectUnauthorized:false
        // is fine here since Neon terminates TLS with a publicly-trusted cert
        // chain that Node's default CA bundle usually already trusts — this
        // just avoids friction with intermediate cert quirks on some hosts.
        ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bulk_runs (
                run_id UUID PRIMARY KEY,
                loginid TEXT NOT NULL,
                strategy_count INTEGER NOT NULL,
                started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                ended_at TIMESTAMPTZ,
                total_profit NUMERIC,
                summary JSONB
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS signal_history (
                id BIGSERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                total_ticks INTEGER NOT NULL,
                top_contract_type TEXT,
                top_prediction INTEGER,
                top_confidence INTEGER,
                stats JSONB NOT NULL,
                signals JSONB NOT NULL
            );
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS signal_history_symbol_time_idx
                ON signal_history (symbol, recorded_at DESC);
        `);
        ready = true;
        // eslint-disable-next-line no-console
        console.log('[db] Postgres connected — run history + signal history will be logged.');
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[db] Failed to initialise Postgres, continuing without persistence:', err.message);
        pool = null;
    }
};

await init();

export const logRunStart = async (run_id, loginid, strategy_configs) => {
    if (!ready || !pool) return;
    try {
        await pool.query('INSERT INTO bulk_runs (run_id, loginid, strategy_count) VALUES ($1, $2, $3)', [
            run_id,
            loginid,
            strategy_configs.length,
        ]);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[db] Failed to log run start:', err.message);
    }
};

export const logRunEnd = async (run_id, strategy_results) => {
    if (!ready || !pool) return;
    const total_profit = strategy_results.reduce((sum, s) => sum + (s.total_profit || 0), 0);
    try {
        await pool.query(
            'UPDATE bulk_runs SET ended_at = now(), total_profit = $2, summary = $3 WHERE run_id = $1',
            [run_id, total_profit, JSON.stringify(strategy_results)]
        );
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[db] Failed to log run end:', err.message);
    }
};

/**
 * Snapshots one symbol's current stats + ranked signals into signal_history.
 * Called periodically (not on every tick — see marketFeed's throttle) so this
 * becomes a time series you can later use to check how well the confidence
 * score actually tracked outcomes, without hammering the database.
 */
export const logSignalSnapshot = async (symbol, stats, signals) => {
    if (!ready || !pool) return;
    const top = signals[0];
    try {
        await pool.query(
            `INSERT INTO signal_history
                (symbol, total_ticks, top_contract_type, top_prediction, top_confidence, stats, signals)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                symbol,
                stats.total_ticks,
                top?.contract_type ?? null,
                typeof top?.prediction === 'number' ? top.prediction : null,
                top?.confidence ?? null,
                JSON.stringify(stats),
                JSON.stringify(signals),
            ]
        );
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[db] Failed to log signal snapshot:', err.message);
    }
};

/** Most recent signal_history rows for one symbol, newest first. */
export const getSignalHistory = async (symbol, limit = 100) => {
    if (!ready || !pool) return [];
    try {
        const { rows } = await pool.query(
            `SELECT symbol, recorded_at, total_ticks, top_contract_type, top_prediction, top_confidence, stats, signals
             FROM signal_history WHERE symbol = $1 ORDER BY recorded_at DESC LIMIT $2`,
            [symbol, Math.min(Math.max(Number(limit) || 100, 1), 500)]
        );
        return rows;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[db] Failed to fetch signal history:', err.message);
        return [];
    }
};

export const isPersistenceEnabled = () => ready;
