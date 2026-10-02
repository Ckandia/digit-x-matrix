// Stores the AI's learned results as small AGGREGATES per (profile, symbol,
// contract type, duration): wins, losses, stake, profit, payout ratio.
// No ticks and no digit data are stored here, so this is not the tick-derived
// content that signal_history has to purge after 24h. Profile ids are
// client-side hashes, never a raw Deriv login id or token.
// Uses Neon/Postgres when DATABASE_URL is set; otherwise falls back to memory
// (lost on a Render restart, and the browser keeps its own copy either way).
import { getPool } from './db.js';

const memory = new Map(); // profile -> Map(cellKey -> cell)
const PROFILE_RE = /^[A-Za-z0-9_-]{8,80}$/;
const SYMBOL_RE = /^[A-Za-z0-9_]{2,20}$/;
const TYPE_RE = /^[A-Z]{3,16}$/;
let tableReady = false;

export const isValidProfile = p => PROFILE_RE.test(String(p || ''));

const ensureTable = async pool => {
    if (tableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS learning_stats (
            profile TEXT NOT NULL,
            symbol TEXT NOT NULL,
            contract_type TEXT NOT NULL,
            duration INTEGER NOT NULL,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            staked NUMERIC NOT NULL DEFAULT 0,
            profit NUMERIC NOT NULL DEFAULT 0,
            payout_ratio_sum NUMERIC NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (profile, symbol, contract_type, duration)
        );
    `);
    tableReady = true;
};

/** Returns a clean outcome or null if the payload is not acceptable. */
export const parseOutcome = b => {
    const duration = Math.round(Number(b?.duration));
    const stake = Number(b?.stake);
    const profit = Number(b?.profit);
    const payout = Number(b?.payout);
    if (!isValidProfile(b?.profile) || !SYMBOL_RE.test(b?.symbol || '') || !TYPE_RE.test(b?.contract_type || ''))
        return null;
    if (!(duration >= 1 && duration <= 10) || !(stake > 0 && stake < 100000) || !Number.isFinite(profit)) return null;
    return {
        profile: b.profile,
        symbol: b.symbol,
        contract_type: b.contract_type,
        duration,
        stake,
        profit,
        win: profit > 0,
        payout_ratio: payout > stake ? payout / stake : 0,
    };
};

export const recordOutcome = async o => {
    const pool = getPool();
    if (pool) {
        await ensureTable(pool);
        await pool.query(
            `INSERT INTO learning_stats (profile, symbol, contract_type, duration, wins, losses, staked, profit, payout_ratio_sum)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (profile, symbol, contract_type, duration) DO UPDATE SET
                wins = learning_stats.wins + EXCLUDED.wins,
                losses = learning_stats.losses + EXCLUDED.losses,
                staked = learning_stats.staked + EXCLUDED.staked,
                profit = learning_stats.profit + EXCLUDED.profit,
                payout_ratio_sum = learning_stats.payout_ratio_sum + EXCLUDED.payout_ratio_sum,
                updated_at = now()`,
            [o.profile, o.symbol, o.contract_type, o.duration, o.win ? 1 : 0, o.win ? 0 : 1, o.stake, o.profit, o.payout_ratio]
        );
        return;
    }
    const cells = memory.get(o.profile) || new Map();
    memory.set(o.profile, cells);
    const k = `${o.symbol}|${o.contract_type}|${o.duration}`;
    const c = cells.get(k) || { symbol: o.symbol, contract_type: o.contract_type, duration: o.duration, wins: 0, losses: 0, staked: 0, profit: 0, payout_ratio_sum: 0 };
    c.wins += o.win ? 1 : 0;
    c.losses += o.win ? 0 : 1;
    c.staked += o.stake;
    c.profit += o.profit;
    c.payout_ratio_sum += o.payout_ratio;
    cells.set(k, c);
};

export const getStats = async profile => {
    const pool = getPool();
    if (pool) {
        await ensureTable(pool);
        const { rows } = await pool.query(
            `SELECT symbol, contract_type, duration, wins, losses, staked::float8 AS staked, profit::float8 AS profit,
                    payout_ratio_sum::float8 AS payout_ratio_sum
             FROM learning_stats WHERE profile = $1`,
            [profile]
        );
        return rows;
    }
    return [...(memory.get(profile)?.values() || [])];
};
