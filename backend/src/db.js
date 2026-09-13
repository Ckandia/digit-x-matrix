import pg from 'pg';

const { Pool } = pg;

let pool = null;
let ready = false;

const init = async () => {
    if (!process.env.DATABASE_URL) return;
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
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
        ready = true;
        // eslint-disable-next-line no-console
        console.log('[db] Postgres connected — run history will be logged.');
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

export const isPersistenceEnabled = () => ready;
